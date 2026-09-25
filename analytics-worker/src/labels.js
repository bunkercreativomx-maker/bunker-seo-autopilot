// Deterministic query labels: Phase 3 keyword mapping, search intent (the
// Phase 3 classifier, unchanged) and branded / non-branded classification.
import { classifyIntent } from "../../strategy-worker/src/classify.js";
import { overlapScore } from "../../strategy-worker/src/normalize.js";
import { normalizeQuery } from "./analytics.js";

const compact = (s) => fold(s).replace(/\s+/g, "");
// Accent-insensitive comparison key (searchers often omit accents: juarez/juárez).
export const fold = (s) => normalizeQuery(s).normalize("NFD").replace(/\p{M}+/gu, "");

/**
 * Brand terms from Phase 3 data only: the client's business name, verified
 * business facts of type business_name/brand, and the website domain label.
 */
export function brandTerms({ businessName = "", facts = [], domain = "" } = {}) {
  const terms = new Set();
  const add = (v) => { const n = fold(v); if (n.length >= 3) terms.add(n); };
  add(businessName);
  for (const f of facts) if (["business_name", "brand"].includes(f.fact_type) && f.verification_state !== "rejected") add(f.value);
  const label = String(domain || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[./]/)[0];
  if (label && label.length >= 4) add(label);
  return [...terms];
}

export function brandOf(query, terms, override) {
  if (override === "branded" || override === "non_branded") return override;
  if (!terms.length) return "unknown";
  const q = fold(query);
  const qc = compact(query);
  for (const t of terms) {
    const tc = t.replace(/\s+/g, "");
    if (q.includes(t) || (tc.length >= 5 && qc.includes(tc))) return "branded";
    // Distinctive brand token (e.g. "tlaloc") present on its own.
    const tokens = t.split(" ").filter((x) => x.length >= 5);
    if (tokens.some((tok) => q.split(" ").includes(tok))) return "branded";
  }
  return "non_branded";
}

/**
 * Map a Search Console query against the Phase 3 strategy.
 * - known_keyword: exact normalized match with a strategy keyword
 * - related_variant: strong token overlap with a strategy keyword
 * - new_query: a strategy exists but the query matches no keyword
 * - unmapped: the website has no strategy keywords to compare against
 */
export function mapQuery(query, keywords, { variantThreshold = 0.75 } = {}) {
  const nq = fold(query);
  if (!keywords.length) return { mapping: "unmapped", keyword: null };
  let best = null, bestScore = 0;
  for (const k of keywords) {
    const nk = fold(k.normalized_keyword || k.keyword);
    if (nk === nq) return { mapping: "known_keyword", keyword: k };
    const score = Math.min(overlapScore(nq, nk), overlapScore(nk, nq)) >= variantThreshold ? (overlapScore(nq, nk) + overlapScore(nk, nq)) / 2 : 0;
    if (score > bestScore) { best = k; bestScore = score; }
  }
  if (best) return { mapping: "related_variant", keyword: best };
  return { mapping: "new_query", keyword: null };
}

/**
 * @param queries [{query}]
 * @param ctx { keywords:[{id, keyword, normalized_keyword, target_page_url}], brand:[terms], locations:[...], services:[...], overrides: Map(nq -> brand) }
 */
export function labelQueries(queries, ctx) {
  const out = [];
  const seen = new Set();
  for (const r of queries) {
    const nq = normalizeQuery(r.query);
    if (!nq || seen.has(nq)) continue;
    seen.add(nq);
    const m = mapQuery(r.query, ctx.keywords || []);
    const intent = classifyIntent(r.query, { locations: ctx.locations || [], brand: (ctx.brand || [])[0] || "" });
    out.push({
      normalized_query: nq,
      query: r.query,
      mapping: m.mapping,
      keyword: m.keyword?.id || "",
      mapped_page: m.keyword?.target_page_url || "",
      intent,
      brand: brandOf(r.query, ctx.brand || [], ctx.overrides?.get(nq)),
      source: "google_search_console",
    });
  }
  return out;
}
