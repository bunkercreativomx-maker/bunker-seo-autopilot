// Deterministic Search Console analytics: aggregation, comparisons and the
// opportunity detectors. No AI and no invented metrics — every number here is
// derived from clicks/impressions/ctr/position returned by Google.
import crypto from "node:crypto";

export const DEFAULT_SETTINGS = Object.freeze({
  window_days: 28,
  min_days_with_data: 14,
  low_ctr: { min_impressions: 100, max_position: 20, ratio: 0.5, min_baseline_impressions: 200 },
  zero_click: { min_impressions: 100, max_position: 10 },
  striking: { min_position: 4, max_position: 20, min_impressions: 50 },
  decay: { min_prev_clicks: 10, min_click_drop: 5, click_drop_pct: 0.3, min_prev_impressions: 200, impression_drop_pct: 0.3 },
  position_decline: { min_impressions: 100, min_drop: 3 },
  growth: { min_clicks: 10, min_click_gain: 5, click_gain_pct: 0.5, min_impressions: 200, impression_gain_pct: 0.5, min_impression_gain: 100 },
  new_query: { min_impressions: 20 },
  mismatch: { min_impressions: 50 },
  cannibalization: { min_impressions: 20, min_share: 0.2 },
  resolve_after_days: 7,
  max_per_type: 50,
});

export function mergeSettings(custom = {}) {
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  for (const [k, v] of Object.entries(custom || {})) {
    if (!(k in out)) continue;
    if (typeof out[k] === "object" && v && typeof v === "object") {
      for (const [kk, vv] of Object.entries(v)) if (kk in out[k] && Number.isFinite(Number(vv))) out[k][kk] = Number(vv);
    } else if (typeof out[k] === "number" && Number.isFinite(Number(v))) out[k] = Number(v);
  }
  return out;
}

// ---------------------------------------------------------------- math
export function ctr(clicks, impressions) {
  return impressions > 0 ? clicks / impressions : 0;
}

/**
 * Aggregate daily rows. CTR = total clicks / total impressions (never an
 * average of CTRs). Position = impression-weighted mean of the daily average
 * positions reported by Google (averaging averages blindly is wrong).
 */
export function aggregate(rows) {
  let clicks = 0, impressions = 0, weighted = 0, days = new Set();
  for (const r of rows) {
    const c = Number(r.clicks) || 0, i = Number(r.impressions) || 0;
    clicks += c; impressions += i; weighted += (Number(r.position) || 0) * i;
    if (r.date) days.add(r.date);
  }
  return { clicks, impressions, ctr: ctr(clicks, impressions), position: impressions > 0 ? weighted / impressions : null, days: days.size };
}

export function change(current, previous) {
  const abs = current - previous;
  return { current, previous, abs, pct: previous > 0 ? abs / previous : null };
}

export function compareTotals(cur, prev) {
  return {
    clicks: change(cur.clicks, prev.clicks),
    impressions: change(cur.impressions, prev.impressions),
    ctr: change(cur.ctr, prev.ctr),
    // Lower is better for position; `abs` < 0 means improvement.
    position: cur.position === null || prev.position === null ? { current: cur.position, previous: prev.position, abs: null, pct: null } : change(cur.position, prev.position),
  };
}

// ---------------------------------------------------------------- helpers
export function normalizeQuery(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("und").replace(/[’']/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function normalizePage(url) {
  try {
    const u = new URL(String(url));
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    let path = u.pathname.replace(/\/+$/, "") || "/";
    return `${host}${path}${u.search}`;
  } catch {
    return String(url || "").trim().toLowerCase();
  }
}

export function dedupeKey(type, query, page) {
  return crypto.createHash("sha256").update(`${type}|${normalizeQuery(query || "")}|${page ? normalizePage(page) : ""}`).digest("hex");
}

const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
const fmtPct = (n) => `${((Number(n) || 0) * 100).toFixed(1)}%`;
const fmtPos = (n) => (n === null || n === undefined ? "n/a" : Number(n).toFixed(1));
const metrics = (m) => ({ clicks: m.clicks, impressions: m.impressions, ctr: Number(m.ctr.toFixed(6)), position: m.position === null ? null : Number(m.position.toFixed(2)), days: m.days });
function periodText(p) { return `${p.start} – ${p.end}`; }

const COMMERCIAL_INTENTS = new Set(["commercial", "transactional", "local"]);

/** Priority from evidence only: volume, trend size and commercial intent. */
export function priorityFor({ impressions = 0, clicksDelta = 0, intent = "", hasPage = false }) {
  const commercial = COMMERCIAL_INTENTS.has(intent);
  if (impressions >= 1000 || Math.abs(clicksDelta) >= 50 || (commercial && impressions >= 300)) return "high";
  if (impressions >= 200 || Math.abs(clicksDelta) >= 10 || (commercial && hasPage && impressions >= 100)) return "medium";
  return "low";
}

function positionBucket(position) {
  if (position === null) return null;
  if (position <= 3) return "1-3";
  if (position <= 10) return "4-10";
  if (position <= 20) return "11-20";
  return null;
}

/** Site's own CTR per position range (the baseline for "low CTR"). */
export function ctrBaselines(queries, minImpressions) {
  const acc = {};
  for (const q of queries) {
    const b = positionBucket(q.position);
    if (!b) continue;
    acc[b] = acc[b] || { clicks: 0, impressions: 0 };
    acc[b].clicks += q.clicks; acc[b].impressions += q.impressions;
  }
  const out = {};
  for (const [b, v] of Object.entries(acc)) if (v.impressions >= minImpressions) out[b] = { ctr: ctr(v.clicks, v.impressions), impressions: v.impressions };
  return out;
}

// ---------------------------------------------------------------- detectors
/**
 * @param input {
 *   period: { start, end, prevStart, prevEnd, days },
 *   current: { queries:[{query, clicks, impressions, ctr, position, days}], pages:[…page…], queryPages:[{query,page,…}] },
 *   previous: same shape or null,
 *   coverage: { currentDays, previousDays },
 *   labels: Map(normalized_query -> { mapping, intent, brand, mapped_page }),
 *   settings,
 * }
 * @returns array of opportunities (not yet persisted)
 */
export function detectOpportunities(input) {
  const s = mergeSettings(input.settings);
  const period = input.period;
  const labels = input.labels || new Map();
  const cur = input.current;
  const prev = input.previous;
  const trendOk = Boolean(prev) && (input.coverage?.currentDays ?? 0) >= s.min_days_with_data && (input.coverage?.previousDays ?? 0) >= s.min_days_with_data;
  const out = [];
  const label = (q) => labels.get(normalizeQuery(q)) || {};
  const prevPeriod = prev ? { start: period.prevStart, end: period.prevEnd } : null;

  // Landing pages per query (top page by impressions) and page lists.
  const pagesByQuery = new Map();
  for (const r of cur.queryPages || []) {
    const k = normalizeQuery(r.query);
    if (!pagesByQuery.has(k)) pagesByQuery.set(k, []);
    pagesByQuery.get(k).push(r);
  }
  for (const list of pagesByQuery.values()) list.sort((a, b) => b.impressions - a.impressions);
  const landing = (q) => pagesByQuery.get(normalizeQuery(q))?.[0]?.page || "";

  const push = (o) => out.push({ ...o, dedupe_key: dedupeKey(o.type, o.query, o.page) });
  const baseEvidence = (extra) => ({ source: "google_search_console", window_days: period.days, current_period: { start: period.start, end: period.end }, previous_period: prevPeriod, data_state: "final", ...extra });

  // --- High impressions / low CTR (vs the site's own CTR at similar positions)
  const baselines = ctrBaselines(cur.queries, s.low_ctr.min_baseline_impressions);
  for (const q of cur.queries) {
    const lb = label(q.query);
    if (q.position === null || q.position > s.low_ctr.max_position) continue;
    // Zero-click with meaningful impressions at a visible position.
    if (q.clicks === 0 && q.impressions >= s.zero_click.min_impressions && q.position <= s.zero_click.max_position) {
      const page = landing(q.query);
      push({
        type: "high_impressions_low_ctr", query: q.query, page, current_period: metrics(q), previous_period: null,
        evidence: baseEvidence({ query: q.query, page, current: metrics(q), zero_click: true }),
        reason: `During ${periodText(period)} (finalized data) the query "${q.query}" received ${fmtInt(q.impressions)} impressions and 0 clicks at an average position of ${fmtPos(q.position)}.`,
        recommended_action: "Review the landing page title, meta description and whether the page matches the search intent shown in the SERP. Zero clicks can also come from SERP features or brand/intent mismatch; this is a hypothesis to verify, not a confirmed cause.",
        priority: priorityFor({ impressions: q.impressions, intent: lb.intent, hasPage: Boolean(page) }),
      });
      continue;
    }
    const bucket = positionBucket(q.position);
    const base = bucket ? baselines[bucket] : null;
    if (!base || q.impressions < s.low_ctr.min_impressions || q.clicks === 0) continue;
    if (q.ctr < base.ctr * s.low_ctr.ratio) {
      const page = landing(q.query);
      push({
        type: "high_impressions_low_ctr", query: q.query, page, current_period: metrics(q), previous_period: null,
        evidence: baseEvidence({ query: q.query, page, current: metrics(q), baseline: { position_range: bucket, ctr: Number(base.ctr.toFixed(6)), impressions: base.impressions } }),
        reason: `During ${periodText(period)} the query "${q.query}" received ${fmtInt(q.impressions)} impressions and ${fmtInt(q.clicks)} clicks (CTR ${fmtPct(q.ctr)}) at an average position of ${fmtPos(q.position)}. Queries on this site at average positions ${bucket} had a CTR of ${fmtPct(base.ctr)}.`,
        recommended_action: "Review title/meta and SERP intent for the landing page. Position, SERP layout, brand and competition also affect CTR.",
        priority: priorityFor({ impressions: q.impressions, intent: lb.intent, hasPage: Boolean(page) }),
      });
    }
  }

  // --- Striking distance
  for (const q of cur.queries) {
    if (q.position === null || q.position < s.striking.min_position || q.position > s.striking.max_position || q.impressions < s.striking.min_impressions) continue;
    const page = landing(q.query);
    const lb = label(q.query);
    push({
      type: "striking_distance", query: q.query, page, current_period: metrics(q), previous_period: null,
      evidence: baseEvidence({ query: q.query, page, current: metrics(q), position_range: [s.striking.min_position, s.striking.max_position] }),
      reason: `Query received ${fmtInt(q.impressions)} impressions at average position ${fmtPos(q.position)} during ${periodText(period)}.`,
      recommended_action: "Review whether the landing page fully answers this query (content depth, headings, internal links). Average position is a mean, not a fixed rank; improvement is not guaranteed.",
      priority: priorityFor({ impressions: q.impressions, intent: lb.intent, hasPage: Boolean(page) }),
    });
  }

  // --- New queries (not known to the Phase 3 strategy)
  for (const q of cur.queries) {
    const lb = label(q.query);
    if (lb.mapping !== "new_query" || q.impressions < s.new_query.min_impressions) continue;
    const page = landing(q.query);
    push({
      type: "new_query", query: q.query, page, current_period: metrics(q), previous_period: null,
      evidence: baseEvidence({ query: q.query, page, current: metrics(q), intent: lb.intent || null, brand: lb.brand || "unknown", note: "Google showed the site for this query. This is not a measure of global search volume." }),
      reason: `Google showed the site for "${q.query}" ${fmtInt(q.impressions)} times (${fmtInt(q.clicks)} clicks, average position ${fmtPos(q.position)}) during ${periodText(period)}; the query is not in the current SEO strategy.`,
      recommended_action: "Review whether this query deserves a place in the SEO strategy (existing page optimization or a new content opportunity). Nothing is created automatically.",
      priority: lb.brand === "branded" ? "low" : priorityFor({ impressions: q.impressions, intent: lb.intent, hasPage: Boolean(page) }),
    });
  }

  // --- Page/query mismatch: Phase 3 maps the query to a page, Google ranks another.
  for (const q of cur.queries) {
    const lb = label(q.query);
    if (!lb.mapped_page || q.impressions < s.mismatch.min_impressions) continue;
    const top = landing(q.query);
    if (!top || normalizePage(top) === normalizePage(lb.mapped_page)) continue;
    push({
      type: "page_query_mismatch", query: q.query, page: top, current_period: metrics(q), previous_period: null,
      evidence: baseEvidence({ query: q.query, landing_page: top, strategy_target_page: lb.mapped_page, intent: lb.intent || null, current: metrics(q) }),
      reason: `During ${periodText(period)} Google mostly showed ${top} for "${q.query}" (${fmtInt(q.impressions)} impressions), while the SEO strategy targets ${lb.mapped_page}.`,
      recommended_action: "Review whether the strategy target page should be strengthened (content, internal links) or the strategy mapping updated. Nothing is changed automatically.",
      priority: priorityFor({ impressions: q.impressions, intent: lb.intent, hasPage: true }),
    });
  }

  // --- Potential cannibalization with real data (not asserted automatically).
  for (const [nq, list] of pagesByQuery) {
    const total = list.reduce((a, r) => a + r.impressions, 0);
    const strong = list.filter((r) => r.impressions >= s.cannibalization.min_impressions && total > 0 && r.impressions / total >= s.cannibalization.min_share);
    if (strong.length < 2) continue;
    const query = list[0].query;
    push({
      type: "potential_cannibalization", query, page: "", current_period: { impressions: total }, previous_period: null,
      evidence: baseEvidence({ query, pages: strong.map((r) => ({ page: r.page, clicks: r.clicks, impressions: r.impressions, position: r.position === null ? null : Number(r.position.toFixed(2)), share: Number((r.impressions / total).toFixed(3)) })) }),
      reason: `During ${periodText(period)} ${strong.length} pages each received at least ${Math.round(s.cannibalization.min_share * 100)}% of the ${fmtInt(total)} impressions for "${query}".`,
      recommended_action: "Review whether these pages target the same intent. Multiple pages for one query is not always a problem; confirm before merging or re-targeting.",
      priority: priorityFor({ impressions: total, intent: label(query).intent, hasPage: true }),
    });
  }

  if (trendOk) {
    const prevQ = new Map(prev.queries.map((r) => [normalizeQuery(r.query), r]));
    const prevP = new Map(prev.pages.map((r) => [normalizePage(r.page), r]));
    // --- Content decay (pages)
    for (const p of cur.pages) {
      const b = prevP.get(normalizePage(p.page));
      if (!b) continue;
      const dClicks = p.clicks - b.clicks;
      const clickDecay = b.clicks >= s.decay.min_prev_clicks && -dClicks >= s.decay.min_click_drop && -dClicks / b.clicks >= s.decay.click_drop_pct;
      const imprDecay = b.impressions >= s.decay.min_prev_impressions && (b.impressions - p.impressions) / b.impressions >= s.decay.impression_drop_pct;
      if (!clickDecay && !imprDecay) continue;
      push({
        type: "content_decay", query: "", page: p.page, current_period: metrics(p), previous_period: metrics(b),
        evidence: baseEvidence({ page: p.page, current: metrics(p), previous: metrics(b), click_change: change(p.clicks, b.clicks), impression_change: change(p.impressions, b.impressions) }),
        reason: `During the last ${period.days} finalized days (${periodText(period)}) this page received ${fmtInt(p.impressions)} impressions and ${fmtInt(p.clicks)} clicks. In the previous ${period.days}-day period (${periodText(prevPeriod)}) it received ${fmtInt(b.impressions)} impressions and ${fmtInt(b.clicks)} clicks.`,
        recommended_action: "Performance declined compared with the previous period. Check for seasonality, SERP changes or outdated content before editing; one comparison does not prove a permanent decline.",
        priority: priorityFor({ impressions: b.impressions, clicksDelta: dClicks, hasPage: true }),
      });
    }
    // --- Position decline (queries)
    for (const q of cur.queries) {
      const b = prevQ.get(normalizeQuery(q.query));
      if (!b || q.position === null || b.position === null) continue;
      if (q.impressions < s.position_decline.min_impressions || b.impressions < s.position_decline.min_impressions) continue;
      if (q.position - b.position < s.position_decline.min_drop) continue;
      const page = landing(q.query);
      push({
        type: "position_decline", query: q.query, page, current_period: metrics(q), previous_period: metrics(b),
        evidence: baseEvidence({ query: q.query, page, current: metrics(q), previous: metrics(b) }),
        reason: `Average position for "${q.query}" went from ${fmtPos(b.position)} (${periodText(prevPeriod)}) to ${fmtPos(q.position)} (${periodText(period)}) with ${fmtInt(q.impressions)} impressions in the current period.`,
        recommended_action: "Declined compared with the previous period. Review the landing page and competing results; verify over a longer window before acting.",
        priority: priorityFor({ impressions: q.impressions, intent: label(q.query).intent, hasPage: Boolean(page) }),
      });
    }
    // --- Growth (queries and pages) — informative; never recommend aggressive edits.
    const growth = (type, item, before, keyQuery, keyPage) => {
      const dClicks = item.clicks - before.clicks;
      const clicksGrow = item.clicks >= s.growth.min_clicks && dClicks >= s.growth.min_click_gain && (before.clicks === 0 || dClicks / before.clicks >= s.growth.click_gain_pct);
      const dImpr = item.impressions - before.impressions;
      const imprGrow = item.impressions >= s.growth.min_impressions && dImpr >= s.growth.min_impression_gain && (before.impressions === 0 || dImpr / before.impressions >= s.growth.impression_gain_pct);
      if (clicksGrow) {
        push({
          type, query: keyQuery, page: keyPage, current_period: metrics(item), previous_period: metrics(before),
          evidence: baseEvidence({ query: keyQuery || undefined, page: keyPage || undefined, current: metrics(item), previous: metrics(before), click_change: change(item.clicks, before.clicks) }),
          reason: `Clicks grew from ${fmtInt(before.clicks)} (${periodText(prevPeriod)}) to ${fmtInt(item.clicks)} (${periodText(period)}); impressions ${fmtInt(before.impressions)} → ${fmtInt(item.impressions)}.`,
          recommended_action: "This content is gaining traction. Avoid disruptive changes; consider supporting it with internal links.",
          priority: "low",
        });
      } else if (imprGrow && type === "growing_page") {
        push({
          type: "impression_growth", query: "", page: keyPage, current_period: metrics(item), previous_period: metrics(before),
          evidence: baseEvidence({ page: keyPage, current: metrics(item), previous: metrics(before), impression_change: change(item.impressions, before.impressions) }),
          reason: `Impressions grew from ${fmtInt(before.impressions)} to ${fmtInt(item.impressions)} compared with the previous ${period.days}-day period, with ${fmtInt(item.clicks)} clicks.`,
          recommended_action: "Google is showing this page more often. Review whether title/meta match the new queries it appears for.",
          priority: priorityFor({ impressions: item.impressions, hasPage: true }) === "high" ? "medium" : "low",
        });
      }
    };
    for (const q of cur.queries) { const b = prevQ.get(normalizeQuery(q.query)) || { clicks: 0, impressions: 0, ctr: 0, position: null, days: 0 }; growth("growing_query", q, b, q.query, landing(q.query)); }
    for (const p of cur.pages) { const b = prevP.get(normalizePage(p.page)) || { clicks: 0, impressions: 0, ctr: 0, position: null, days: 0 }; growth("growing_page", p, b, "", p.page); }
  }

  // Cap per type (keep the strongest evidence) and drop exact duplicates.
  const byKey = new Map();
  for (const o of out) if (!byKey.has(o.dedupe_key)) byKey.set(o.dedupe_key, o);
  const rank = { high: 3, medium: 2, low: 1 };
  const grouped = new Map();
  for (const o of byKey.values()) { if (!grouped.has(o.type)) grouped.set(o.type, []); grouped.get(o.type).push(o); }
  const final = [];
  for (const list of grouped.values()) {
    list.sort((a, b) => rank[b.priority] - rank[a.priority] || (b.current_period?.impressions || 0) - (a.current_period?.impressions || 0));
    final.push(...list.slice(0, s.max_per_type));
  }
  return final;
}

/**
 * Merge detections into existing opportunities (dedupe by key).
 * - new key → create with status "new"
 * - existing → refresh evidence/last_detected_at; human decisions
 *   (accepted/ignored/reviewed) are preserved; "resolved" reopens as "new".
 * - not detected for `resolve_after_days` → auto-resolve only "new" ones.
 */
export function reconcile(existing, detected, { now = new Date().toISOString(), resolveAfterDays = 7 } = {}) {
  const map = new Map(existing.map((e) => [e.dedupe_key, e]));
  const creates = [], updates = [], resolves = [];
  const seen = new Set();
  for (const d of detected) {
    seen.add(d.dedupe_key);
    const e = map.get(d.dedupe_key);
    const fields = { query: d.query || "", page: d.page || "", current_period: d.current_period, previous_period: d.previous_period, evidence: d.evidence, reason: d.reason, recommended_action: d.recommended_action, priority: d.priority, last_detected_at: now, updated_at: now };
    if (!e) creates.push({ ...fields, type: d.type, dedupe_key: d.dedupe_key, status: "new", source: "google_search_console", first_detected_at: now, detection_count: 1, created_at: now });
    else updates.push({ id: e.id, ...fields, detection_count: Number(e.detection_count || 0) + 1, ...(e.status === "resolved" ? { status: "new", resolved_at: null } : {}) });
  }
  const cutoff = Date.parse(now) - resolveAfterDays * 86400000;
  for (const e of existing) {
    if (seen.has(e.dedupe_key) || e.status !== "new") continue;
    if (Date.parse(e.last_detected_at || e.first_detected_at || now) < cutoff) resolves.push({ id: e.id, status: "resolved", resolved_at: now, updated_at: now });
  }
  return { creates, updates, resolves };
}
