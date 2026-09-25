// Deterministic Autopilot decision engine (Phase 7).
//
//   Signals + Strategy + Policy + Budgets + Risk + Existing Work → Decisions
//
// Pure functions only: no I/O, no AI, no clock reads (ctx.now is injected).
// The same inputs always yield the same decisions, so every decision can be
// explained later from its stored evidence. AI never decides permissions.

export const DECISION_TYPES = [
  "NO_ACTION", "MONITOR", "REFRESH_CRAWL", "REFRESH_STRATEGY", "CREATE_CONTENT", "OPTIMIZE_EXISTING_CONTENT", "REVIEW_METADATA",
  "INVESTIGATE_TECHNICAL_ISSUE", "WAIT_FOR_MORE_DATA", "PAUSE_INTEGRATION", "PUBLISH_APPROVED_ARTICLE", "VERIFY_PUBLICATION",
  "RECHECK_ARTICLE", "REQUEST_HUMAN_REVIEW",
];

const DAY = 86_400_000;
const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, monitor: 4 };
// Business-fact topics a page cannot invent. Matched deterministically against
// the opportunity's keyword/title; each needs a VERIFIED fact of that type.
export const FACT_TOPICS = [
  { type: "price", label: "price", re: /\b(precio|precios|costo|costos|cu[aá]nto cuesta|tarifa|tarifas|price|prices|pricing|cost|costs)\b/i },
  { type: "warranty", label: "warranty", re: /\b(garant[ií]a|garant[ií]as|warranty|warranties|guarantee)\b/i },
  { type: "financing", label: "financing", re: /\b(financiamiento|financiar|cr[eé]dito|meses sin intereses|financing|finance|loan|loans)\b/i },
  { type: "certification", label: "certification", re: /\b(certificad[oa]s?|certificaci[oó]n|certified|certification|licencia|licensed)\b/i },
  { type: "promotion", label: "promotion", re: /\b(promoci[oó]n|descuento|oferta|promo|discount|offer)\b/i },
];
const REGULATED_RE = /\b(m[eé]dic[oa]s?|salud|tratamiento|diagn[oó]stico|legal|abogad[oa]|ley|impuesto|fiscal|inversi[oó]n|rendimiento|pr[eé]stamo|seguro|medical|health|treatment|lawyer|tax|investment|loan|insurance)\b/i;
const GENERATE_TYPES = ["create", "service", "location", "expand", "optimize", "refresh"];

export function normalizeText(v) {
  return String(v ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9ñ]+/g, " ").trim();
}

function ageDays(iso, now) {
  if (!iso) return null;
  const t = Date.parse(String(iso).replace(" ", "T"));
  return Number.isFinite(t) ? Math.floor((now - t) / DAY) : null;
}

export function missingFacts(text, verifiedTypes, { contentType = "", targetLocation = "" } = {}) {
  const missing = [];
  for (const topic of FACT_TOPICS) if (topic.re.test(text) && !verifiedTypes.has(topic.type)) missing.push(topic.label);
  if (contentType === "location_page" && !verifiedTypes.has("location") && !verifiedTypes.has("service_area")) missing.push("service area / location" + (targetLocation ? ` (${targetLocation})` : ""));
  return missing;
}

export function riskLevel(text) {
  return REGULATED_RE.test(text) ? "high" : "low";
}

// Deterministic score from explicit inputs. Documented weights; no AI math.
export function scoreOpportunity(opp) {
  const base = { high: 70, medium: 50, low: 30, critical: 70 }[opp.priority] ?? 30; // critical is capped: SEO opportunities are never "critical"
  const intent = { commercial: 10, transactional: 10, local: 8, mixed: 5, informational: 0, navigational: -10 }[opp.intent] ?? 0;
  const gap = opp.existing_page ? 0 : 5;
  const confidence = Math.round((Number(opp.confidence) || 0) * 10);
  return base + intent + gap + confidence;
}

function priorityFromScore(score) {
  if (score >= 80) return "high";
  if (score >= 55) return "medium";
  return "low";
}

// ---------------------------------------------------------------- budgets

export function budgetCheck(kind, ctx, planned) {
  const p = ctx.policy;
  const u = ctx.usage;
  const plannedCount = (t) => planned.filter((x) => x === t).length;
  const actionsToday = u.actions_today + planned.length;
  if (actionsToday >= p.max_actions_per_day) return { code: "BUDGET_LIMIT", detail: `daily action limit ${p.max_actions_per_day} reached (${actionsToday})` };
  if (kind === "GENERATE_CONTENT" || kind === "REQUEST_REVISION") {
    if (kind === "GENERATE_CONTENT") {
      const today = u.content_today + plannedCount("GENERATE_CONTENT");
      const week = u.content_week + plannedCount("GENERATE_CONTENT");
      if (today >= p.max_content_jobs_per_day) return { code: "BUDGET_LIMIT", detail: `daily article limit ${p.max_content_jobs_per_day} reached (${today})` };
      if (week >= p.max_content_jobs_per_week) return { code: "BUDGET_LIMIT", detail: `weekly article limit ${p.max_content_jobs_per_week} reached (${week})` };
    }
    const est = ctx.estimates?.content_job || { calls: null, tokens: null, cost: null };
    const calls = u.ai_calls_today + (est.calls ?? 0);
    if (u.ai_calls_today >= p.max_ai_calls_daily || (est.calls !== null && calls > p.max_ai_calls_daily)) return { code: "BUDGET_LIMIT", detail: `AI call limit ${p.max_ai_calls_daily}/day (used ${u.ai_calls_today}, estimate ${est.calls ?? "unknown"})` };
    if (u.ai_tokens_today >= p.max_ai_tokens_daily || (est.tokens !== null && u.ai_tokens_today + est.tokens > p.max_ai_tokens_daily)) return { code: "BUDGET_LIMIT", detail: `AI token limit ${p.max_ai_tokens_daily}/day (used ${u.ai_tokens_today}, estimate ${est.tokens ?? "unknown"})` };
    // Dollar budgets only bind where pricing is configured; unknown cost is never treated as $0.
    if (u.ai_cost_today.known !== null && u.ai_cost_today.known >= p.max_ai_budget_daily) return { code: "BUDGET_LIMIT", detail: `daily AI budget $${p.max_ai_budget_daily} reached ($${u.ai_cost_today.known.toFixed(2)} known)` };
    if (u.ai_cost_month.known !== null && u.ai_cost_month.known >= p.max_ai_budget_monthly) return { code: "BUDGET_LIMIT", detail: `monthly AI budget $${p.max_ai_budget_monthly} reached` };
    if (est.cost !== null && u.ai_cost_today.known !== null && u.ai_cost_today.known + est.cost > p.max_ai_budget_daily) return { code: "BUDGET_LIMIT", detail: `estimated cost $${est.cost.toFixed(2)} would exceed daily AI budget` };
  }
  if (kind === "PUBLISH" || kind === "UPDATE_PUBLICATION") {
    const week = u.publications_week + plannedCount("PUBLISH") + plannedCount("UPDATE_PUBLICATION");
    if (week >= p.max_publications_per_week) return { code: "BUDGET_LIMIT", detail: `weekly publication limit ${p.max_publications_per_week} reached (${week})` };
  }
  if (kind === "STRATEGY_REFRESH" && u.strategy_week + plannedCount("STRATEGY_REFRESH") >= p.max_strategy_refresh_per_week) return { code: "BUDGET_LIMIT", detail: `strategy refresh limit ${p.max_strategy_refresh_per_week}/week reached` };
  if (kind === "CRAWL" && u.crawls_week + plannedCount("CRAWL") >= p.max_crawls_per_week) return { code: "BUDGET_LIMIT", detail: `crawl limit ${p.max_crawls_per_week}/week reached` };
  return null;
}

// Circuit breaker groups: one open circuit pauses every action that depends
// on the same failing integration (e.g. publisher auth → publish/update/verify).
export function circuitGroup(actionType) {
  if (["PUBLISH", "UPDATE_PUBLICATION", "VERIFY_PUBLICATION"].includes(actionType)) return "PUBLISH";
  if (["GENERATE_CONTENT", "REQUEST_REVISION", "RECHECK_CONTENT"].includes(actionType)) return "GENERATE_CONTENT";
  return actionType;
}

// Gate every executable action through: policy allow-list → circuit breaker →
// dependency health → budget. Returns a block {code, detail} or null.
export function gate(actionType, ctx, planned) {
  const p = ctx.policy;
  if (!(p.allowed_actions || []).includes(actionType)) return { code: "POLICY_NOT_ALLOWED", detail: `${actionType} is not in allowed_actions` };
  if (ctx.circuits?.[circuitGroup(actionType)] === "open") return { code: "CIRCUIT_OPEN", detail: `${actionType} paused after repeated failures` };
  const dep = { CRAWL: "crawler", STRATEGY_REFRESH: "strategy", GENERATE_CONTENT: "content", REQUEST_REVISION: "content", RECHECK_CONTENT: "content", PUBLISH: "publisher", UPDATE_PUBLICATION: "publisher", VERIFY_PUBLICATION: "publisher" }[actionType];
  if (dep && ctx.health && ctx.health[dep] === false) return { code: "DEPENDENCY_UNHEALTHY", detail: `${dep} worker queue is stalled` };
  return budgetCheck(actionType, ctx, planned);
}

function decision(d) {
  return { priority: "low", score: 0, risk_level: "low", requires_approval: false, planned_action: null, block_code: "", ...d };
}

// ---------------------------------------------------------------- main

export function decide(signals, ctx) {
  const out = [];
  const planned = []; // action types planned in this evaluation (budget accounting)
  const now = ctx.now;
  const p = ctx.policy;
  const byType = (t) => signals.filter((s) => s.signal_type === t);
  const plan = (d, action) => {
    const block = gate(action.action_type, ctx, planned);
    if (block) {
      out.push(decision({ ...d, block_code: block.code, reason: `${d.reason} — blocked: ${block.detail}`, planned_action: { ...action, blocked: true } }));
      return false;
    }
    planned.push(action.action_type);
    out.push(decision({ ...d, planned_action: action }));
    return true;
  };

  // 1. Search Console state. No data is NOT a performance signal.
  if (ctx.gsc.state === "no_data") {
    out.push(decision({ decision_type: "WAIT_FOR_MORE_DATA", priority: "monitor", rule: "gsc.no_data", reason: "Search Console property is connected but returned no rows yet; no ranking/CTR/decay conclusions are drawn.", evidence: { gsc_state: "NO_DATA", property: ctx.gsc.property || null, latest_final_date: ctx.gsc.latest_final_date || null, rows: ctx.gsc.rows || 0 } }));
  } else if (ctx.gsc.state === "not_connected") {
    out.push(decision({ decision_type: "WAIT_FOR_MORE_DATA", priority: "monitor", rule: "gsc.not_connected", reason: "Search Console is not connected for this website; analytics-driven optimization is unavailable.", evidence: { gsc_state: "NOT_CONNECTED" } }));
  }
  for (const s of byType("GSC_CONNECTION_LOST")) {
    out.push(decision({ signal: s, decision_type: "PAUSE_INTEGRATION", priority: "critical", rule: "gsc.connection_lost", requires_approval: true, reason: "Google Search Console access was lost; analytics actions are paused until an admin reconnects.", evidence: s.evidence, planned_action: { action_type: "NOTIFY_HUMAN", target_type: "gsc_connection", target_id: s.source_record, idempotency_key: `notify:gsc_lost:${s.source_record}`, task: { kind: "integration_reconnect", title: "Reconnect Google Search Console" } } }));
  }

  // 2. Freshness: crawl, then strategy (strategy waits for a fresh crawl).
  const staleCrawl = byType("STALE_CRAWL")[0];
  if (staleCrawl) {
    if (ctx.crawl.active) out.push(decision({ signal: staleCrawl, decision_type: "NO_ACTION", priority: "low", rule: "crawl.active", reason: "A crawl is already running.", evidence: staleCrawl.evidence }));
    else plan({ signal: staleCrawl, decision_type: "REFRESH_CRAWL", priority: "medium", score: 50, rule: "crawl.stale", reason: `Last completed crawl is ${staleCrawl.evidence.age_days ?? "missing"} days old (max ${p.crawl_max_age_days}).`, evidence: staleCrawl.evidence }, { action_type: "CRAWL", target_type: "website", target_id: ctx.website.id, idempotency_key: `crawl:${ctx.website.id}:${ctx.crawl.last_id || "none"}` });
  }
  const staleStrategy = byType("STALE_STRATEGY")[0];
  if (staleStrategy) {
    if (ctx.strategy.active) out.push(decision({ signal: staleStrategy, decision_type: "NO_ACTION", priority: "low", rule: "strategy.active", reason: "A strategy job is already running.", evidence: staleStrategy.evidence }));
    else if (staleCrawl || ctx.crawl.active) out.push(decision({ signal: staleStrategy, decision_type: "NO_ACTION", priority: "low", rule: "strategy.waits_for_crawl", reason: "Strategy refresh waits for the crawl to finish first.", evidence: staleStrategy.evidence }));
    else plan({ signal: staleStrategy, decision_type: "REFRESH_STRATEGY", priority: "medium", score: 45, rule: "strategy.stale", reason: staleStrategy.evidence.reason, evidence: staleStrategy.evidence }, { action_type: "STRATEGY_REFRESH", target_type: "website", target_id: ctx.website.id, idempotency_key: `strategy:${ctx.website.id}:${ctx.strategy.last_version_id || "none"}:${ctx.crawl.last_id || "none"}` });
  }

  // 3. Technical issues → human investigation. Never edits website code.
  for (const s of byType("TECHNICAL_ISSUE")) {
    const pr = s.evidence.severity === "critical" ? "high" : s.evidence.severity === "high" ? "medium" : "low";
    out.push(decision({ signal: s, decision_type: "INVESTIGATE_TECHNICAL_ISSUE", priority: pr, score: pr === "high" ? 60 : 40, rule: "technical.issue", requires_approval: true, reason: `${s.evidence.count} open "${s.evidence.issue_type}" issue(s) from the crawler. Autopilot does not modify website code; a human must investigate.`, evidence: s.evidence, planned_action: { action_type: "NOTIFY_HUMAN", target_type: "seo_issue_type", target_id: s.evidence.issue_type, idempotency_key: `notify:tech:${ctx.website.id}:${s.evidence.issue_type}`, task: { kind: "technical_issue", title: `Investigate: ${s.evidence.title || s.evidence.issue_type}` } } }));
  }

  // 4. Managed articles (event continuation state).
  for (const s of byType("PUBLICATION_FAILED")) {
    out.push(decision({ signal: s, decision_type: "REQUEST_HUMAN_REVIEW", priority: "critical", rule: "publication.failed", requires_approval: true, reason: `Publication failed (${s.evidence.error_code || "unknown"}). A human must fix the integration or content before retrying.`, evidence: s.evidence, planned_action: { action_type: "NOTIFY_HUMAN", target_type: "article", target_id: s.source_record, idempotency_key: `notify:pubfail:${s.source_record}:${s.evidence.job || ""}`, task: { kind: "publishing_integration", title: "Publishing failed — review integration" } } }));
  }
  for (const s of byType("ARTICLE_NEEDS_REVIEW")) {
    const a = ctx.articles.find((x) => x.id === s.source_record);
    if (!a) continue;
    if (a.status === "awaiting_approval") {
      out.push(decision({ signal: s, decision_type: "REQUEST_HUMAN_REVIEW", priority: a.high_risk ? "high" : "medium", rule: "article.awaiting_approval", requires_approval: true, risk_level: a.high_risk ? "high" : "low", reason: "Draft passed the Phase 4 pipeline and awaits human approval. Autopilot never approves content.", evidence: s.evidence }));
    } else if (a.status === "failed") {
      out.push(decision({ signal: s, decision_type: "REQUEST_HUMAN_REVIEW", priority: "medium", rule: "article.failed", requires_approval: true, reason: "The Phase 4 pipeline failed for this article; Autopilot does not add another retry layer. A human decides whether to retry.", evidence: s.evidence, planned_action: { action_type: "NOTIFY_HUMAN", target_type: "article", target_id: a.id, idempotency_key: `notify:failed:${a.id}:v${a.current_version}`, task: { kind: "human_review", title: `Content generation failed: ${a.title || a.primary_keyword}` } } }));
    } else if (a.status === "needs_revision" && a.fact_check_status === "blocked" && p.pause_on_fact_failure) {
      out.push(decision({ signal: s, decision_type: "REQUEST_HUMAN_REVIEW", priority: "high", rule: "article.fact_failure", requires_approval: true, reason: "Fact check is BLOCKED (unsupported/contradicted high-risk claims). pause_on_fact_failure: no automatic revision; a human must review the claims or business facts.", evidence: s.evidence, planned_action: { action_type: "NOTIFY_HUMAN", target_type: "article", target_id: a.id, idempotency_key: `notify:factfail:${a.id}:v${a.current_version}`, task: { kind: "missing_facts", title: `Fact check blocked: ${a.title || a.primary_keyword}` } } }));
    } else if (a.status === "needs_revision") {
      const used = ctx.revisionsByArticle?.[a.id] || 0;
      if (a.managed && used < p.max_revision_jobs_per_article) {
        plan({ signal: s, decision_type: "RECHECK_ARTICLE", priority: "medium", score: 40, rule: "article.needs_revision.auto", reason: `Phase 4 returned needs_revision; automatic revision ${used + 1}/${p.max_revision_jobs_per_article} allowed by policy.`, evidence: { ...s.evidence, revisions_used: used } }, { action_type: "REQUEST_REVISION", target_type: "article", target_id: a.id, idempotency_key: `revision:${a.id}:v${a.current_version}:${used + 1}` });
      } else {
        out.push(decision({ signal: s, decision_type: "REQUEST_HUMAN_REVIEW", priority: "medium", rule: "article.needs_revision.limit", requires_approval: true, reason: `Automatic revision limit reached (${used}/${p.max_revision_jobs_per_article}). A human must edit and recheck.`, evidence: { ...s.evidence, revisions_used: used }, planned_action: { action_type: "NOTIFY_HUMAN", target_type: "article", target_id: a.id, idempotency_key: `notify:review:${a.id}:v${a.current_version}`, task: { kind: "human_review", title: `Review article: ${a.title || a.primary_keyword}` } } }));
      }
    }
  }
  for (const s of byType("ARTICLE_APPROVED")) {
    const a = ctx.articles.find((x) => x.id === s.source_record);
    if (!a) continue;
    const d = { signal: s, evidence: s.evidence, risk_level: a.high_risk ? "high" : "low" };
    if (a.high_risk) out.push(decision({ ...d, decision_type: "REQUEST_HUMAN_REVIEW", priority: "high", rule: "publish.high_risk", requires_approval: true, reason: "High-risk content always waits for a manual Publish (Phase 7 invariant).", planned_action: { action_type: "NOTIFY_HUMAN", target_type: "article", target_id: a.id, idempotency_key: `notify:highrisk:${a.id}:${a.approved_hash}`, task: { kind: "high_risk_review", title: "High-risk article approved — publish manually after review" } } }));
    else if (!p.publish_after_human_approval || a.eligible_for_auto_publish === false) out.push(decision({ ...d, decision_type: "REQUEST_HUMAN_REVIEW", priority: "medium", rule: "publish.manual", requires_approval: true, reason: p.publish_after_human_approval ? "Approval happened before publish_after_human_approval was enabled (or outside an Autopilot-managed draft): waiting for a human to press Publish." : "publish_after_human_approval is off: waiting for a human to press Publish." }));
    else if (!(p.allowed_environments || []).includes(ctx.website.publishing_environment)) out.push(decision({ ...d, decision_type: "REQUEST_HUMAN_REVIEW", priority: "medium", rule: "publish.environment", block_code: "ENVIRONMENT_NOT_ALLOWED", requires_approval: true, reason: `Publishing environment "${ctx.website.publishing_environment || "none"}" is not allowed by the Autopilot policy.` }));
    else if (ctx.website.connection_status !== "connected") out.push(decision({ ...d, decision_type: "REQUEST_HUMAN_REVIEW", priority: "high", rule: "publish.integration", block_code: "INTEGRATION_NOT_CONNECTED", requires_approval: true, reason: `Publishing integration is ${ctx.website.connection_status || "not configured"}.`, planned_action: { action_type: "NOTIFY_HUMAN", target_type: "website", target_id: ctx.website.id, idempotency_key: `notify:integration:${ctx.website.id}:${ctx.website.connection_status}`, task: { kind: "publishing_integration", title: "Fix the publishing integration" } } }));
    else {
      const live = a.publication && ["published", "verification_required"].includes(a.publication.status);
      const type = live ? "UPDATE_PUBLICATION" : "PUBLISH";
      plan({ ...d, decision_type: "PUBLISH_APPROVED_ARTICLE", priority: "medium", score: 55, rule: "publish.after_human_approval", reason: `Human approval by ${a.approved_by_name || a.approved_by} (v${a.approved_version}); policy publish_after_human_approval = true; target ${ctx.website.publishing_environment}.` }, { action_type: type, target_type: "article", target_id: a.id, idempotency_key: `publish:${a.id}:${a.approved_hash}`, expected_hash: a.approved_hash });
    }
  }
  for (const s of byType("PUBLICATION_UNVERIFIED")) {
    plan({ signal: s, decision_type: "VERIFY_PUBLICATION", priority: "high", score: 60, rule: "publication.verification_required", reason: "Publication needs verification.", evidence: s.evidence }, { action_type: "VERIFY_PUBLICATION", target_type: "article", target_id: s.source_record, idempotency_key: `verify:${s.source_record}:${s.evidence.publication_updated || ""}` });
  }

  // 5. Analytics feedback — real data only (signals exist only when GSC has rows).
  for (const s of signals.filter((x) => x.source === "search_console" && x.signal_type !== "GSC_CONNECTION_LOST")) {
    const e = s.evidence || {};
    const base = { signal: s, evidence: e };
    if (s.signal_type === "GROWING_PAGE" || s.signal_type === "GROWING_QUERY") {
      out.push(decision({ ...base, decision_type: "MONITOR", priority: "monitor", rule: "analytics.growing", reason: "Content is growing; monitor instead of rewriting." }));
      continue;
    }
    if (e.opportunity_status !== "accepted") {
      out.push(decision({ ...base, decision_type: "NO_ACTION", priority: "low", rule: "analytics.not_accepted", reason: `Phase 6 opportunity is "${e.opportunity_status}"; Autopilot acts only on opportunities a human accepted.` }));
      continue;
    }
    if (s.signal_type === "POTENTIAL_CANNIBALIZATION") {
      out.push(decision({ ...base, decision_type: "REQUEST_HUMAN_REVIEW", priority: "medium", rule: "analytics.cannibalization", requires_approval: true, reason: "Possible cannibalization: a human decides which page should own the query.", planned_action: { action_type: "NOTIFY_HUMAN", target_type: "analytics_opportunity", target_id: s.source_record, idempotency_key: `notify:cannibal:${s.source_record}`, task: { kind: "human_review", title: "Review possible cannibalization" } } }));
      continue;
    }
    const article = ctx.articles.find((a) => a.managed && a.publication && a.publication.public_url && e.page && normalizeUrl(a.publication.public_url) === normalizeUrl(e.page));
    if (!article) {
      const t = s.signal_type === "LOW_CTR" ? "REVIEW_METADATA" : "REQUEST_HUMAN_REVIEW";
      out.push(decision({ ...base, decision_type: t, priority: "low", rule: "analytics.unmanaged_page", requires_approval: true, reason: "The page is not an Autopilot-managed publication; Autopilot never edits website pages directly." }));
      continue;
    }
    const sinceChange = ageDays(article.last_changed_at, now);
    if (sinceChange !== null && sinceChange < p.optimization_cooldown_days) {
      out.push(decision({ ...base, decision_type: "WAIT_FOR_MORE_DATA", priority: "monitor", rule: "analytics.cooldown", reason: `Page changed ${sinceChange} days ago; optimization cooldown is ${p.optimization_cooldown_days} days.` }));
      continue;
    }
    const used = ctx.revisionsByArticle?.[article.id] || 0;
    if (used >= p.max_revision_jobs_per_article) {
      out.push(decision({ ...base, decision_type: "REQUEST_HUMAN_REVIEW", priority: "low", rule: "analytics.revision_limit", requires_approval: true, reason: "Automatic revision limit reached for this article." }));
      continue;
    }
    plan({ ...base, decision_type: "OPTIMIZE_EXISTING_CONTENT", priority: "medium", score: 45, rule: "analytics.optimize", reason: `Accepted Phase 6 ${s.signal_type} opportunity on an Autopilot-managed page; a revision creates a NEW version that needs human approval before any update is published.` }, { action_type: "REQUEST_REVISION", target_type: "article", target_id: article.id, idempotency_key: `optimize:${article.id}:${s.source_record}`, instruction: String(e.recommended_action || e.reason || `Improve the page for "${e.query || ""}"`).slice(0, 1500) });
  }

  // 6. Content opportunities (approved Phase 3 opportunities only).
  const candidates = [];
  for (const s of [...byType("CONTENT_GAP"), ...byType("NEW_CONTENT_OPPORTUNITY")]) {
    const opp = ctx.opportunities.find((o) => o.id === s.source_record);
    if (!opp) continue;
    candidates.push({ s, opp, score: scoreOpportunity(opp) });
  }
  candidates.sort((a, b) => b.score - a.score || String(a.opp.id).localeCompare(String(b.opp.id)));
  for (const { s, opp, score } of candidates) {
    const text = `${opp.keyword_text || ""} ${opp.title_suggestion || ""}`;
    const evidence = { ...s.evidence, score_inputs: { phase3_priority: opp.priority, intent: opp.intent || null, existing_page: opp.existing_page || null, confidence: opp.confidence ?? null } };
    const d = { signal: s, evidence, score, priority: priorityFromScore(score), risk_level: riskLevel(text) };
    if (!GENERATE_TYPES.includes(opp.opportunity_type)) {
      out.push(decision({ ...d, decision_type: "NO_ACTION", priority: "low", rule: "content.unsupported_type", reason: `Opportunity type "${opp.opportunity_type}" does not generate content.` }));
      continue;
    }
    const own = ctx.articles.find((a) => a.content_opportunity === opp.id);
    if (own) {
      out.push(decision({ ...d, decision_type: "NO_ACTION", priority: "low", rule: own.status === "rejected" ? "content.rejected_memory" : "content.article_exists", reason: own.status === "rejected" ? "A human rejected the article for this opportunity; Autopilot will not recreate it." : `Article ${own.id} already exists for this opportunity (${own.status}).`, evidence: { ...evidence, existing_article: own.id, existing_status: own.status } }));
      continue;
    }
    const kw = normalizeText(opp.keyword_text || opp.title_suggestion);
    const dup = kw && ctx.articles.find((a) => a.status !== "rejected" && (normalizeText(a.primary_keyword) === kw || (opp.recommended_url && a.recommended_url && normalizeUrl(a.recommended_url) === normalizeUrl(opp.recommended_url))));
    if (dup) {
      out.push(decision({ ...d, decision_type: "REQUEST_HUMAN_REVIEW", rule: "content.duplicate_intent", requires_approval: true, reason: `Article ${dup.id} already targets the same keyword/URL; creating another page would compete for the same intent.`, evidence: { ...evidence, duplicate_article: dup.id } }));
      continue;
    }
    const cannibal = kw && ctx.cannibalization.find((c) => c.keyword_norm && (c.keyword_norm === kw || kw.includes(c.keyword_norm) || c.keyword_norm.includes(kw)));
    if (cannibal) {
      out.push(decision({ ...d, decision_type: "REQUEST_HUMAN_REVIEW", rule: "content.cannibalization", requires_approval: true, reason: `Open cannibalization issue "${cannibal.keyword_group}" overlaps this keyword; Autopilot will not add another page automatically.`, evidence: { ...evidence, cannibalization_issue: cannibal.id } }));
      continue;
    }
    const missing = missingFacts(text, ctx.facts.verified_types, { contentType: opp.recommended_page_type === "location_page" || opp.opportunity_type === "location" ? "location_page" : "", targetLocation: opp.target_location });
    if (missing.length) {
      out.push(decision({ ...d, decision_type: "REQUEST_HUMAN_REVIEW", rule: "content.missing_business_facts", requires_approval: true, reason: `Missing verified business facts: ${missing.join(", ")}. Autopilot never invents or verifies business facts.`, evidence: { ...evidence, missing_facts: missing }, planned_action: { action_type: "NOTIFY_HUMAN", target_type: "content_opportunity", target_id: opp.id, idempotency_key: `notify:facts:${opp.id}`, task: { kind: "missing_facts", title: `Verify business facts: ${missing.join(", ")}` } } }));
      continue;
    }
    const type = opp.existing_page ? "OPTIMIZE_EXISTING_CONTENT" : "CREATE_CONTENT";
    plan({ ...d, decision_type: type, rule: "content.approved_opportunity", reason: `Approved Phase 3 ${opp.opportunity_type} opportunity "${opp.keyword_text || opp.title_suggestion}" ${opp.existing_page ? "on an existing page" : "with no mapped page"}; no existing article or duplicate intent.${d.risk_level === "high" ? " Regulated topic: draft allowed, publication always needs human review." : ""}` }, { action_type: "GENERATE_CONTENT", target_type: "content_opportunity", target_id: opp.id, idempotency_key: `generate:${ctx.website.id}:opp:${opp.id}` });
  }

  if (!out.length) out.push(decision({ decision_type: "NO_ACTION", priority: "monitor", rule: "no_signals", reason: "No active signals require action.", evidence: { signal_count: signals.length } }));
  out.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || b.score - a.score);
  return out;
}

export function normalizeUrl(u) {
  try {
    const x = new URL(String(u));
    return (x.host.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch { return String(u || "").toLowerCase().replace(/\/+$/, ""); }
}

// Dry-run / plan summary shown to humans (what Autopilot WOULD do).
export function summarize(decisions, ctx) {
  const executable = decisions.filter((d) => d.planned_action && !d.block_code && d.planned_action.action_type !== "NOTIFY_HUMAN");
  const has = (t) => executable.some((d) => d.planned_action.action_type === t);
  const gen = executable.filter((d) => d.planned_action.action_type === "GENERATE_CONTENT");
  const est = ctx.estimates?.content_job || {};
  return {
    would_refresh_crawl: has("CRAWL"),
    would_refresh_strategy: has("STRATEGY_REFRESH"),
    would_generate_content: gen.length > 0,
    content: gen.map((d) => ({ opportunity: d.signal?.source_record, keyword: d.signal?.evidence?.keyword || d.signal?.evidence?.title || "", reason: d.reason, priority: d.priority, score: d.score })),
    would_publish: has("PUBLISH") || has("UPDATE_PUBLICATION") ? "yes — an article already has human approval" : "no — human approval required first",
    blocked: decisions.filter((d) => d.block_code).map((d) => ({ decision: d.decision_type, code: d.block_code, reason: d.reason })),
    human_review: decisions.filter((d) => d.decision_type === "REQUEST_HUMAN_REVIEW" || d.decision_type === "INVESTIGATE_TECHNICAL_ISSUE").length,
    analytics: ctx.gsc.state === "has_data" ? "real Search Console data available" : ctx.gsc.state === "no_data" ? "WAIT_FOR_MORE_DATA (Search Console has no rows yet)" : ctx.gsc.state,
    estimated_ai_usage: gen.length ? (est.calls === null || est.calls === undefined ? { calls: "unknown", tokens: "unknown", cost: "unknown" } : { calls: est.calls * gen.length, tokens: est.tokens * gen.length, cost: est.cost === null ? "unknown (pricing not configured)" : Number((est.cost * gen.length).toFixed(4)) }) : { calls: 0, tokens: 0, cost: 0 },
  };
}
