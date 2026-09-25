// Signal derivation (pure) + error classification (pure).
// Signals are derived from REAL persisted state. Search Console signals exist
// only when the property returned rows; zero rows means NO_DATA, never a
// performance signal (no CONTENT_DECAY / LOW_CTR / ranking conclusions).

const DAY = 86_400_000;

function ageDays(iso, now) {
  if (!iso) return null;
  const t = Date.parse(String(iso).replace(" ", "T"));
  return Number.isFinite(t) ? Math.floor((now - t) / DAY) : null;
}

const ANALYTICS_MAP = {
  striking_distance: "STRIKING_DISTANCE",
  high_impressions_low_ctr: "LOW_CTR",
  content_decay: "CONTENT_DECAY",
  position_decline: "CONTENT_DECAY",
  new_query: "NEW_QUERY",
  page_query_mismatch: "PAGE_QUERY_MISMATCH",
  potential_cannibalization: "POTENTIAL_CANNIBALIZATION",
  growing_page: "GROWING_PAGE",
  growing_query: "GROWING_QUERY",
  impression_growth: "GROWING_PAGE",
  optimization_candidate: "STRIKING_DISTANCE",
};
const PERFORMANCE_SIGNALS = new Set(["LOW_CTR", "CONTENT_DECAY", "STRIKING_DISTANCE", "NEW_QUERY", "PAGE_QUERY_MISMATCH", "GROWING_PAGE", "GROWING_QUERY", "POTENTIAL_CANNIBALIZATION"]);

function hasRealMetrics(opp) {
  const cur = opp.current_period || {};
  const ev = opp.evidence || {};
  const imp = Number(cur.impressions ?? ev.impressions ?? ev.current?.impressions ?? 0);
  return Number.isFinite(imp) && imp > 0;
}

export function deriveSignals(ctx) {
  const now = ctx.now;
  const p = ctx.policy;
  const w = ctx.website.id;
  const out = [];
  const add = (s) => out.push({ strength: 0.5, expires_at: null, ...s, dedup_key: `${w}:${s.signal_type}:${s.key}` });

  // Crawler freshness + technical issues
  const crawlAge = ageDays(ctx.crawl.last_completed_at, now);
  if (!ctx.crawl.active && (crawlAge === null || crawlAge > p.crawl_max_age_days)) {
    add({ signal_type: "STALE_CRAWL", source: "crawler", source_record: ctx.crawl.last_id || "", key: "crawl", strength: 0.6, evidence: { last_crawl: ctx.crawl.last_id || null, last_completed_at: ctx.crawl.last_completed_at || null, age_days: crawlAge, max_age_days: p.crawl_max_age_days } });
  }
  for (const g of ctx.technical || []) {
    add({ signal_type: "TECHNICAL_ISSUE", source: "crawler", source_record: g.sample_issue || "", key: g.issue_type, strength: g.severity === "critical" ? 0.9 : g.severity === "high" ? 0.7 : 0.4, evidence: { issue_type: g.issue_type, severity: g.severity, count: g.count, title: g.title || "", sample_pages: g.sample_pages || [] } });
  }

  // Strategy freshness
  const stratAge = ageDays(ctx.strategy.last_generated_at, now);
  const crawledAfter = ctx.crawl.last_completed_at && ctx.strategy.last_generated_at && Date.parse(ctx.crawl.last_completed_at.replace(" ", "T")) > Date.parse(ctx.strategy.last_generated_at.replace(" ", "T"));
  const material = crawledAfter && (ctx.crawl.material_changes || 0) >= (ctx.materialChangeThreshold ?? 5);
  if (!ctx.strategy.active && (stratAge === null || stratAge > p.strategy_max_age_days || material)) {
    const reason = stratAge === null ? "No strategy exists yet." : material ? `Crawl after the last strategy detected ${ctx.crawl.material_changes} material page changes.` : `Strategy is ${stratAge} days old (max ${p.strategy_max_age_days}).`;
    add({ signal_type: "STALE_STRATEGY", source: "strategy", source_record: ctx.strategy.last_version_id || "", key: "strategy", strength: 0.5, evidence: { last_version: ctx.strategy.last_version_id || null, generated_at: ctx.strategy.last_generated_at || null, age_days: stratAge, max_age_days: p.strategy_max_age_days, material_changes: ctx.crawl.material_changes || 0, reason } });
  }

  // Approved Phase 3 opportunities (latest strategy only)
  for (const o of ctx.opportunities || []) {
    const gap = !o.existing_page && ["create", "service", "location"].includes(o.opportunity_type);
    add({ signal_type: gap ? "CONTENT_GAP" : "NEW_CONTENT_OPPORTUNITY", source: "strategy", source_record: o.id, key: `opp:${o.id}`, strength: o.priority === "high" ? 0.8 : o.priority === "medium" ? 0.6 : 0.4, evidence: { opportunity: o.id, strategy_version: o.strategy_version, opportunity_type: o.opportunity_type, page_type: o.recommended_page_type || null, keyword: o.keyword_text || "", title: o.title_suggestion || "", phase3_priority: o.priority, status: o.status, intent: o.intent || null, existing_page: o.existing_page || null, recommended_url: o.recommended_url || "" } });
  }

  // Autopilot-managed article states
  for (const a of ctx.articles || []) {
    if (!a.managed) continue;
    if (a.status === "awaiting_approval" || a.status === "needs_revision" || a.status === "failed") add({ signal_type: "ARTICLE_NEEDS_REVIEW", source: "content", source_record: a.id, key: `article:${a.id}:v${a.current_version}:${a.status}`, strength: 0.7, evidence: { article: a.id, status: a.status, version: a.current_version, qa_status: a.qa_status, fact_check_status: a.fact_check_status, high_risk: a.high_risk } });
    if (a.status === "approved" && a.approved_by) add({ signal_type: "ARTICLE_APPROVED", source: "content", source_record: a.id, key: `article:${a.id}:${a.approved_hash}`, strength: 0.8, evidence: { article: a.id, approved_version: a.approved_version, approved_hash: a.approved_hash, approved_by: a.approved_by, approved_at: a.approved_at, high_risk: a.high_risk } });
    if (a.status === "publish_failed") add({ signal_type: "PUBLICATION_FAILED", source: "publishing", source_record: a.id, key: `article:${a.id}:${a.last_publish_job || ""}`, strength: 0.9, evidence: { article: a.id, job: a.last_publish_job || null, error_code: a.last_publish_error || null } });
    if (a.publication && a.publication.status === "verification_required") add({ signal_type: "PUBLICATION_UNVERIFIED", source: "publishing", source_record: a.id, key: `article:${a.id}:${a.publication.updated || ""}`, strength: 0.7, evidence: { article: a.id, publication: a.publication.id, publication_updated: a.publication.updated || "" } });
  }

  // Search Console
  if (ctx.gsc.state === "connection_lost") add({ signal_type: "GSC_CONNECTION_LOST", source: "search_console", source_record: ctx.gsc.connection || "", key: "gsc_connection", strength: 1, evidence: { connection: ctx.gsc.connection || null, status: ctx.gsc.connection_status } });
  if (ctx.gsc.state === "has_data") {
    for (const o of ctx.analytics || []) {
      const t = ANALYTICS_MAP[o.type];
      if (!t || !hasRealMetrics(o)) continue;
      add({ signal_type: t, source: "search_console", source_record: o.id, key: `gsc:${o.dedupe_key || o.id}`, strength: o.priority === "high" ? 0.8 : 0.5, evidence: { analytics_opportunity: o.id, type: o.type, query: o.query || "", page: o.page || "", current_period: o.current_period || null, previous_period: o.previous_period || null, opportunity_status: o.status, recommended_action: o.recommended_action || "", reason: o.reason || "" } });
    }
  }
  return out;
}

// Guard used by tests and the engine: with no GSC data, zero performance signals.
export function performanceSignals(signals) {
  return signals.filter((s) => PERFORMANCE_SIGNALS.has(s.signal_type));
}

// ---------------------------------------------------------------- errors
export const ERROR_CLASSES = ["TRANSIENT", "CONFIGURATION", "AUTH", "POLICY", "DATA", "CONTENT", "SECURITY", "UNKNOWN"];

export function classifyError(code, status) {
  const c = String(code || "").toUpperCase();
  if (/TENANT|FORBIDDEN_TARGET|SSRF|SECURITY|DOMAIN_NOT_ALLOWED/.test(c)) return "SECURITY";
  if (/UNAUTHORIZED|UNAUTHENTICATED|AUTH|INVALID_GRANT|REVOKED|REAUTH|NO_ACTING_USER|401|403/.test(c) || status === 401 || status === 403) return "AUTH";
  if (/TIMEOUT|NETWORK|ECONN|ETIMEDOUT|RATE_LIMIT|429|5\d\d|UNAVAILABLE|BUSY|TRANSIENT|PROVIDER_ERROR/.test(c) || status === 429 || (status >= 500 && status < 600)) return "TRANSIENT";
  if (/POLICY|AUTOPILOT_PAUSED|AUTOPILOT_OFF|NOT_APPROVED|HIGH_RISK|ENVIRONMENT_NOT_ALLOWED|BUDGET|CANCELLED|REJECTED/.test(c)) return "POLICY";
  if (/NOT_CONFIGURED|CONFIG|INTEGRATION|NOT_PUBLISHABLE|INVALID_RESPONSE|NOT_CONNECTED/.test(c)) return "CONFIGURATION";
  if (/SLUG|QA|FACT|CONTENT|RESEARCH|LANGUAGE|NOT_APPROVABLE/.test(c)) return "CONTENT";
  if (/NOT_FOUND|INVALID|DATA|MISMATCH|STALE/.test(c) || status === 400 || status === 404 || status === 409) return "DATA";
  return "UNKNOWN";
}

export function retryable(errorClass) {
  return errorClass === "TRANSIENT";
}
