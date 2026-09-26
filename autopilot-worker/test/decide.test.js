import { test } from "node:test";
import assert from "node:assert/strict";
import { autoPublishBlockers, decide, summarize, gate, budgetCheck, missingFacts, scoreOpportunity, circuitGroup, normalizeUrl } from "../src/decide.js";
import { deriveSignals, performanceSignals, classifyError, retryable } from "../src/signals.js";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

function policy(over = {}) {
  return {
    enabled: true, mode: "SUPERVISED", schedule: "weekly", allowed_actions: ["CRAWL", "STRATEGY_REFRESH", "GENERATE_CONTENT", "RECHECK_CONTENT", "REQUEST_REVISION", "PUBLISH", "VERIFY_PUBLICATION", "UPDATE_PUBLICATION", "AUTO_PUBLISH", "NOTIFY_HUMAN", "WAIT"],
    allowed_environments: ["staging"], max_actions_per_day: 10, max_content_jobs_per_day: 1, max_content_jobs_per_week: 3, max_publications_per_week: 3,
    max_revision_jobs_per_article: 1, max_strategy_refresh_per_week: 1, max_crawls_per_week: 1, max_ai_budget_daily: 5, max_ai_budget_monthly: 50,
    max_ai_calls_daily: 60, max_ai_tokens_daily: 2000000, publish_after_human_approval: false, pause_on_fact_failure: true,
    optimization_cooldown_days: 28, crawl_max_age_days: 14, strategy_max_age_days: 30, version: 3, ...over,
  };
}
const usage0 = () => ({ actions_today: 0, content_today: 0, content_week: 0, publications_week: 0, strategy_week: 0, crawls_week: 0, ai_calls_today: 0, ai_tokens_today: 0, ai_cost_today: { known: null, unknown_calls: 0 }, ai_cost_month: { known: null, unknown_calls: 0 } });

function ctx(over = {}) {
  return {
    now: NOW, website: { id: "w1", publishing_environment: "staging", connection_status: "connected" }, policy: policy(over.policy),
    crawl: { last_id: "c1", last_completed_at: daysAgo(2), active: false, material_changes: 0 },
    strategy: { last_version_id: "sv1", last_generated_at: daysAgo(3), active: false },
    technical: [], opportunities: [], cannibalization: [], facts: { verified_types: new Set(["phone", "email", "service", "location"]) },
    articles: [], revisionsByArticle: {}, gsc: { state: "no_data", property: "p1", rows: 0 }, analytics: [], circuits: {},
    usage: usage0(), estimates: { content_job: { calls: 12, tokens: 60000, cost: null } }, health: { crawler: true, strategy: true, content: true, publisher: true },
    ...over, policy: policy(over.policy),
  };
}
const opp = (over = {}) => ({ id: "o1", strategy_version: "sv1", opportunity_type: "service", recommended_page_type: "service_page", existing_page: "", recommended_url: "/paneles-solares-comercios", title_suggestion: "Paneles solares para comercios", priority: "high", status: "approved", confidence: 0.8, keyword_text: "paneles solares para comercios", intent: "commercial", target_location: "", ...over });
const run = (c) => decide(deriveSignals(c).map((s, i) => ({ ...s, id: `s${i}` })), c);

// ---------------------------------------------------------------- signals
test("no GSC data produces zero performance signals and WAIT_FOR_MORE_DATA", () => {
  const c = ctx({ analytics: [{ id: "a1", type: "content_decay", status: "accepted", current_period: { impressions: 0 } }] });
  const s = deriveSignals(c);
  assert.equal(performanceSignals(s).length, 0);
  const d = run(c);
  assert.ok(d.some((x) => x.decision_type === "WAIT_FOR_MORE_DATA" && x.evidence.gsc_state === "NO_DATA"));
  assert.ok(!d.some((x) => ["OPTIMIZE_EXISTING_CONTENT", "REVIEW_METADATA"].includes(x.decision_type)));
});

test("analytics signals require real rows even when GSC has data", () => {
  const c = ctx({ gsc: { state: "has_data", rows: 50 }, analytics: [
    { id: "a1", type: "high_impressions_low_ctr", status: "accepted", current_period: { impressions: 900, clicks: 3 }, dedupe_key: "k1" },
    { id: "a2", type: "content_decay", status: "accepted", current_period: { impressions: 0 }, dedupe_key: "k2" },
  ] });
  const perf = performanceSignals(deriveSignals(c));
  assert.deepEqual(perf.map((s) => s.signal_type), ["LOW_CTR"]);
});

test("dedup keys are stable across runs", () => {
  const c = ctx({ opportunities: [opp()], technical: [{ issue_type: "missing_title", severity: "high", count: 3 }] });
  const a = deriveSignals(c).map((s) => s.dedup_key);
  const b = deriveSignals(c).map((s) => s.dedup_key);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
});

test("stale crawl and stale strategy signals use real timestamps", () => {
  const fresh = deriveSignals(ctx());
  assert.ok(!fresh.some((s) => s.signal_type === "STALE_CRAWL" || s.signal_type === "STALE_STRATEGY"));
  const stale = deriveSignals(ctx({ crawl: { last_id: "c1", last_completed_at: daysAgo(20), active: false }, strategy: { last_version_id: "sv1", last_generated_at: daysAgo(40), active: false } }));
  assert.ok(stale.some((s) => s.signal_type === "STALE_CRAWL" && s.evidence.age_days === 20));
  assert.ok(stale.some((s) => s.signal_type === "STALE_STRATEGY" && s.evidence.age_days === 40));
});

test("material crawl changes after strategy make strategy stale", () => {
  const s = deriveSignals(ctx({ crawl: { last_id: "c2", last_completed_at: daysAgo(1), active: false, material_changes: 12 }, strategy: { last_version_id: "sv1", last_generated_at: daysAgo(3), active: false } }));
  assert.ok(s.some((x) => x.signal_type === "STALE_STRATEGY" && /material/.test(x.evidence.reason)));
});

test("GSC connection lost → PAUSE_INTEGRATION critical + reconnect task", () => {
  const d = run(ctx({ gsc: { state: "connection_lost", connection: "g1", connection_status: "revoked" } }));
  const x = d.find((y) => y.decision_type === "PAUSE_INTEGRATION");
  assert.equal(x.priority, "critical");
  assert.equal(x.planned_action.task.kind, "integration_reconnect");
});

test("publication failure signal → human review, not retry", () => {
  const d = run(ctx({ articles: [{ id: "ar1", managed: true, status: "publish_failed", last_publish_job: "j1", last_publish_error: "UNAUTHORIZED" }] }));
  const x = d.find((y) => y.decision_type === "REQUEST_HUMAN_REVIEW" && y.rule === "publication.failed");
  assert.ok(x);
  assert.equal(x.planned_action.action_type, "NOTIFY_HUMAN");
});

// ---------------------------------------------------------------- decisions
test("content gap → CREATE_CONTENT with evidence snapshot", () => {
  const d = run(ctx({ opportunities: [opp()] }));
  const x = d.find((y) => y.decision_type === "CREATE_CONTENT");
  assert.ok(x);
  assert.equal(x.planned_action.action_type, "GENERATE_CONTENT");
  assert.equal(x.planned_action.idempotency_key, "generate:w1:opp:o1");
  assert.equal(x.evidence.opportunity, "o1");
  assert.equal(x.evidence.score_inputs.phase3_priority, "high");
  assert.notEqual(x.priority, "critical", "normal SEO opportunities are never critical");
});

test("existing article for the opportunity → NO_ACTION; rejected → rejection memory", () => {
  let d = run(ctx({ opportunities: [opp()], articles: [{ id: "ar1", content_opportunity: "o1", status: "awaiting_approval", primary_keyword: "x" }] }));
  assert.ok(d.some((x) => x.rule === "content.article_exists"));
  d = run(ctx({ opportunities: [opp()], articles: [{ id: "ar1", content_opportunity: "o1", status: "rejected", primary_keyword: "x" }] }));
  assert.ok(d.some((x) => x.rule === "content.rejected_memory"));
  assert.ok(!d.some((x) => x.decision_type === "CREATE_CONTENT"));
});

test("duplicate intent (same keyword on another article) → human review", () => {
  const d = run(ctx({ opportunities: [opp()], articles: [{ id: "ar9", content_opportunity: "oX", status: "approved", primary_keyword: "Paneles solares para comercios" }] }));
  assert.ok(d.some((x) => x.rule === "content.duplicate_intent" && x.evidence.duplicate_article === "ar9"));
  assert.ok(!d.some((x) => x.decision_type === "CREATE_CONTENT"));
});

test("cannibalization guard blocks new page", () => {
  const d = run(ctx({ opportunities: [opp()], cannibalization: [{ id: "ci1", keyword_group: "paneles solares", keyword_norm: "paneles solares" }] }));
  assert.ok(d.some((x) => x.rule === "content.cannibalization"));
  assert.ok(!d.some((x) => x.decision_type === "CREATE_CONTENT"));
});

test("missing business facts → REQUEST_HUMAN_REVIEW with list, no generation", () => {
  const d = run(ctx({ opportunities: [opp({ keyword_text: "precio paneles solares con financiamiento", title_suggestion: "Precios y financiamiento" })] }));
  const x = d.find((y) => y.rule === "content.missing_business_facts");
  assert.deepEqual(x.evidence.missing_facts, ["price", "financing"]);
  assert.equal(x.planned_action.task.kind, "missing_facts");
  assert.ok(!d.some((y) => y.decision_type === "CREATE_CONTENT"));
});

test("missingFacts accepts verified facts", () => {
  assert.deepEqual(missingFacts("garantía de paneles", new Set(["warranty"])), []);
  assert.deepEqual(missingFacts("garantía de paneles", new Set()), ["warranty"]);
});

test("high-risk approved article never auto-publishes, even with policy on", () => {
  const d = run(ctx({ policy: { publish_after_human_approval: true }, articles: [{ id: "ar1", managed: true, eligible_for_auto_publish: true, status: "approved", approved_by: "u1", approved_hash: "h", approved_version: 4, high_risk: true }] }));
  assert.ok(d.some((x) => x.rule === "publish.high_risk"));
  assert.ok(!d.some((x) => x.planned_action?.action_type === "PUBLISH"));
});

test("approved article + policy on + staging → PUBLISH planned with approved hash", () => {
  const d = run(ctx({ policy: { publish_after_human_approval: true }, articles: [{ id: "ar1", managed: true, eligible_for_auto_publish: true, status: "approved", approved_by: "u1", approved_by_name: "Francisco", approved_hash: "abc", approved_version: 4, high_risk: false, publication: null }] }));
  const x = d.find((y) => y.decision_type === "PUBLISH_APPROVED_ARTICLE");
  assert.equal(x.planned_action.action_type, "PUBLISH");
  assert.equal(x.planned_action.expected_hash, "abc");
  assert.equal(x.planned_action.idempotency_key, "publish:ar1:abc");
});

test("publish policy off / production env / disconnected integration / old approval → no publish", () => {
  const art = { id: "ar1", managed: true, eligible_for_auto_publish: true, status: "approved", approved_by: "u1", approved_hash: "abc", approved_version: 4, high_risk: false };
  assert.ok(run(ctx({ articles: [art] })).some((x) => x.rule === "publish.manual"));
  assert.ok(run(ctx({ policy: { publish_after_human_approval: true }, website: { id: "w1", publishing_environment: "production", connection_status: "connected" }, articles: [art] })).some((x) => x.block_code === "ENVIRONMENT_NOT_ALLOWED"));
  assert.ok(run(ctx({ policy: { publish_after_human_approval: true }, website: { id: "w1", publishing_environment: "staging", connection_status: "unauthorized" }, articles: [art] })).some((x) => x.block_code === "INTEGRATION_NOT_CONNECTED"));
  assert.ok(run(ctx({ policy: { publish_after_human_approval: true }, articles: [{ ...art, eligible_for_auto_publish: false }] })).some((x) => x.rule === "publish.manual"));
});

test("needs_revision uses policy revision budget, then human review", () => {
  const art = { id: "ar1", managed: true, status: "needs_revision", current_version: 2, fact_check_status: "issues" };
  let d = run(ctx({ articles: [art] }));
  assert.ok(d.some((x) => x.planned_action?.action_type === "REQUEST_REVISION"));
  d = run(ctx({ articles: [art], revisionsByArticle: { ar1: 1 } }));
  assert.ok(d.some((x) => x.rule === "article.needs_revision.limit"));
  assert.ok(!d.some((x) => x.planned_action?.action_type === "REQUEST_REVISION"));
});

test("fact-check blocked + pause_on_fact_failure → human review, no revision", () => {
  const d = run(ctx({ articles: [{ id: "ar1", managed: true, status: "needs_revision", current_version: 2, fact_check_status: "blocked" }] }));
  assert.ok(d.some((x) => x.rule === "article.fact_failure"));
  assert.ok(!d.some((x) => x.planned_action?.action_type === "REQUEST_REVISION"));
});

test("budget exceeded blocks generation with BUDGET_LIMIT", () => {
  const u = { ...usage0(), content_week: 3 };
  const d = run(ctx({ opportunities: [opp()], usage: u }));
  const x = d.find((y) => y.decision_type === "CREATE_CONTENT");
  assert.equal(x.block_code, "BUDGET_LIMIT");
  assert.match(x.reason, /weekly article limit/);
});

test("daily action limit / AI call limit / daily article limit", () => {
  const c = ctx({ policy: { max_actions_per_day: 1 } });
  assert.equal(budgetCheck("GENERATE_CONTENT", { ...c, usage: { ...usage0(), actions_today: 1 } }, []).code, "BUDGET_LIMIT");
  assert.match(budgetCheck("GENERATE_CONTENT", { ...ctx(), usage: { ...usage0(), ai_calls_today: 55 } }, []).detail, /AI call limit/);
  assert.match(budgetCheck("GENERATE_CONTENT", { ...ctx(), usage: { ...usage0(), content_today: 1 } }, []).detail, /daily article limit/);
  // two opportunities in one evaluation: second one exceeds the daily limit (planned accounting)
  const d = run(ctx({ opportunities: [opp(), opp({ id: "o2", keyword_text: "paneles solares residenciales", recommended_url: "/residencial", title_suggestion: "Residencial" })] }));
  const gen = d.filter((x) => x.decision_type === "CREATE_CONTENT");
  assert.equal(gen.filter((x) => !x.block_code).length, 1);
  assert.equal(gen.filter((x) => x.block_code === "BUDGET_LIMIT").length, 1);
});

test("unknown cost is never treated as $0; known cost enforces dollars", () => {
  const unknown = { ...usage0(), ai_cost_today: { known: null, unknown_calls: 40 } };
  assert.equal(budgetCheck("GENERATE_CONTENT", { ...ctx(), usage: unknown }, []), null, "falls back to call/token limits");
  const known = { ...usage0(), ai_cost_today: { known: 5.2, unknown_calls: 0 } };
  assert.match(budgetCheck("GENERATE_CONTENT", { ...ctx(), usage: known }, []).detail, /daily AI budget/);
  const s = summarize(run(ctx({ opportunities: [opp()] })), ctx());
  assert.equal(s.estimated_ai_usage.cost, "unknown (pricing not configured)");
  const s2 = summarize(run(ctx({ opportunities: [opp()], estimates: { content_job: { calls: null, tokens: null, cost: null } } })), ctx({ estimates: { content_job: { calls: null, tokens: null, cost: null } } }));
  assert.equal(s2.estimated_ai_usage.calls, "unknown");
});

test("worker unavailable blocks dependent actions", () => {
  const d = run(ctx({ opportunities: [opp()], health: { crawler: true, strategy: true, content: false, publisher: true } }));
  assert.equal(d.find((x) => x.decision_type === "CREATE_CONTENT").block_code, "DEPENDENCY_UNHEALTHY");
});

test("stale strategy → REFRESH_STRATEGY; fresh → none; waits for crawl", () => {
  const stale = run(ctx({ strategy: { last_version_id: "sv1", last_generated_at: daysAgo(45), active: false } }));
  assert.ok(stale.some((x) => x.decision_type === "REFRESH_STRATEGY" && !x.block_code));
  assert.ok(!run(ctx()).some((x) => x.decision_type === "REFRESH_STRATEGY"));
  const both = run(ctx({ crawl: { last_id: "c1", last_completed_at: daysAgo(30), active: false }, strategy: { last_version_id: "sv1", last_generated_at: daysAgo(45), active: false } }));
  assert.ok(both.some((x) => x.decision_type === "REFRESH_CRAWL"));
  assert.ok(both.some((x) => x.rule === "strategy.waits_for_crawl"));
});

test("no signals → NO_ACTION (plus WAIT for no GSC data)", () => {
  const d = run(ctx({ gsc: { state: "not_connected" } }));
  assert.ok(d.some((x) => x.decision_type === "WAIT_FOR_MORE_DATA"));
  const d2 = decide([], { ...ctx(), gsc: { state: "has_data" } });
  assert.deepEqual(d2.map((x) => x.decision_type), ["NO_ACTION"]);
});

test("policy allow-list and circuit breaker gate actions", () => {
  const c = ctx({ policy: { allowed_actions: ["NOTIFY_HUMAN"] } });
  assert.equal(gate("GENERATE_CONTENT", c, []).code, "POLICY_NOT_ALLOWED");
  const c2 = ctx({ circuits: { PUBLISH: "open" } });
  assert.equal(gate("VERIFY_PUBLICATION", c2, []).code, "CIRCUIT_OPEN");
  assert.equal(gate("UPDATE_PUBLICATION", c2, []).code, "CIRCUIT_OPEN");
  assert.equal(gate("GENERATE_CONTENT", c2, []), null, "other safe actions continue");
  assert.equal(circuitGroup("RECHECK_CONTENT"), "GENERATE_CONTENT");
});

test("technical issues → INVESTIGATE_TECHNICAL_ISSUE (no code changes)", () => {
  const d = run(ctx({ technical: [{ issue_type: "server_error", severity: "critical", count: 2, title: "5xx" }] }));
  const x = d.find((y) => y.decision_type === "INVESTIGATE_TECHNICAL_ISSUE");
  assert.equal(x.planned_action.action_type, "NOTIFY_HUMAN");
  assert.equal(x.priority, "high");
});

test("analytics loop: accepted opportunity on managed page → revision (new version); cooldown; growing → MONITOR", () => {
  const art = { id: "ar1", managed: true, status: "published", current_version: 5, publication: { public_url: "https://seo-staging.bunkeragent.cloud/tlaloc/blog/x", status: "published" }, last_changed_at: daysAgo(40) };
  const a = { id: "an1", type: "high_impressions_low_ctr", status: "accepted", page: "https://seo-staging.bunkeragent.cloud/tlaloc/blog/x/", query: "paneles", current_period: { impressions: 1200, clicks: 4 }, recommended_action: "Rewrite title", dedupe_key: "k" };
  let d = run(ctx({ gsc: { state: "has_data", rows: 100 }, analytics: [a], articles: [art] }));
  const x = d.find((y) => y.decision_type === "OPTIMIZE_EXISTING_CONTENT");
  assert.equal(x.planned_action.action_type, "REQUEST_REVISION");
  assert.match(x.reason, /NEW version/);
  d = run(ctx({ gsc: { state: "has_data", rows: 100 }, analytics: [a], articles: [{ ...art, last_changed_at: daysAgo(5) }] }));
  assert.ok(d.some((y) => y.rule === "analytics.cooldown"));
  d = run(ctx({ gsc: { state: "has_data", rows: 100 }, analytics: [{ ...a, type: "growing_page", id: "an2", dedupe_key: "k2" }], articles: [art] }));
  assert.ok(d.some((y) => y.decision_type === "MONITOR"));
  d = run(ctx({ gsc: { state: "has_data", rows: 100 }, analytics: [{ ...a, status: "new" }], articles: [art] }));
  assert.ok(d.some((y) => y.rule === "analytics.not_accepted"));
});

test("dry run summary reports what WOULD happen", () => {
  const c = ctx({ opportunities: [opp()] });
  const s = summarize(run(c), c);
  assert.equal(s.would_generate_content, true);
  assert.equal(s.would_refresh_crawl, false);
  assert.match(s.would_publish, /^no/);
  assert.equal(s.content[0].opportunity, "o1");
  assert.match(s.analytics, /WAIT_FOR_MORE_DATA/);
});

test("deterministic: same inputs → same decisions", () => {
  const c = ctx({ opportunities: [opp(), opp({ id: "o3", priority: "low", keyword_text: "energía solar hogar", recommended_url: "/hogar" })] });
  assert.deepEqual(JSON.stringify(run(c)), JSON.stringify(run(c)));
  assert.ok(scoreOpportunity(opp()) > scoreOpportunity(opp({ priority: "low" })));
});

test("error classification: retries only TRANSIENT", () => {
  assert.equal(classifyError("UNAUTHORIZED"), "AUTH");
  assert.equal(classifyError("TIMEOUT"), "TRANSIENT");
  assert.equal(classifyError("X", 503), "TRANSIENT");
  assert.equal(classifyError("SLUG_CONFLICT"), "CONTENT");
  assert.equal(classifyError("HIGH_RISK_REVIEW_REQUIRED"), "POLICY");
  assert.equal(classifyError("TENANT_MISMATCH"), "SECURITY");
  assert.equal(classifyError("NOT_PUBLISHABLE"), "CONFIGURATION");
  assert.equal(retryable("TRANSIENT"), true);
  assert.equal(retryable("AUTH"), false);
});

test("normalizeUrl matches trailing slash and www", () => {
  assert.equal(normalizeUrl("https://www.a.com/x/"), normalizeUrl("https://a.com/x"));
});

// ---------------------------------------------------------------- simple mode (daily posts)
test("auto-pick: approved topics win; one proposed topic per run; review-needing proposed topics are skipped quietly", () => {
  const c = ctx({ policy: { max_content_jobs_per_day: 3, max_content_jobs_per_week: 5 }, opportunities: [
    opp({ id: "p1", status: "proposed", priority: "high", keyword_text: "precio paneles solares", title_suggestion: "Precio paneles", recommended_url: "/precio" }),
    opp({ id: "p2", status: "proposed", priority: "high", keyword_text: "paneles solares comercios", title_suggestion: "Paneles comercios", recommended_url: "/comercios" }),
    opp({ id: "p3", status: "proposed", priority: "medium", keyword_text: "energia solar casas", title_suggestion: "Casas", recommended_url: "/casas" }),
    opp({ id: "a1", status: "approved", priority: "low", keyword_text: "mantenimiento paneles", title_suggestion: "Mantenimiento", recommended_url: "/mantenimiento" }),
  ] });
  const d = run(c);
  const gen = d.filter((x) => x.planned_action?.action_type === "GENERATE_CONTENT" && !x.planned_action.blocked);
  assert.deepEqual(gen.map((x) => x.planned_action.target_id).sort(), ["a1", "p2"]);
  assert.equal(gen.find((x) => x.planned_action.target_id === "p2").rule, "content.auto_picked_topic");
  assert.ok(!d.some((x) => x.decision_type === "REQUEST_HUMAN_REVIEW"), "no review spam for auto-picked topics");
  assert.ok(d.some((x) => x.signal?.source_record === "p1" && x.decision_type === "NO_ACTION" && x.rule === "content.missing_business_facts"));
  assert.ok(!gen.some((x) => x.planned_action.target_id === "p3"));
});

// ---------------------------------------------------------------- safe auto-publish
test("safe auto-publish: only clean posts publish themselves; everything else waits for a human", () => {
  const base = { managed: true, status: "awaiting_approval", current_version: 2, qa_status: "PASS", qa_score: { score: 92 }, fact_check_status: "passed", high_risk: false, risk_categories: [], flags: ["RESEARCH_LIMITED"] };
  const arts = [
    { ...base, id: "ok" },
    { ...base, id: "low", qa_score: { score: 80 } },
    { ...base, id: "fact", fact_check_status: "issues" },
    { ...base, id: "risk", high_risk: true },
    { ...base, id: "claim", flags: ["UNSUPPORTED_PRICE"] },
    { ...base, id: "unknownflag", flags: [{ code: "SOMETHING_NEW" }] },
    { ...base, id: "notmine", managed: false },
  ];
  const on = run(ctx({ policy: { auto_publish_safe: true, max_publications_per_week: 10, max_actions_per_day: 20 }, articles: arts }));
  const auto = on.filter((x) => x.planned_action?.action_type === "AUTO_PUBLISH" && !x.planned_action.blocked).map((x) => x.planned_action.target_id);
  assert.deepEqual(auto, ["ok"]);
  for (const id of ["low", "fact", "risk", "claim", "unknownflag"]) assert.ok(on.some((x) => x.signal?.source_record === id && x.rule === "publish.auto_safe.held"), id);
  assert.ok(!on.some((x) => x.signal?.source_record === "notmine"), "unmanaged articles produce no signal at all");
  // switch off -> nothing auto-publishes
  const off = run(ctx({ policy: { auto_publish_safe: false }, articles: arts }));
  assert.ok(!off.some((x) => x.planned_action?.action_type === "AUTO_PUBLISH"));
  // not connected / production not allowed -> held
  const nc = run(ctx({ policy: { auto_publish_safe: true }, articles: [arts[0]], website: { id: "w1", publishing_environment: "staging", connection_status: "error" } }));
  assert.ok(!nc.some((x) => x.planned_action?.action_type === "AUTO_PUBLISH"));
  const prod = run(ctx({ policy: { auto_publish_safe: true }, articles: [arts[0]], website: { id: "w1", publishing_environment: "production", connection_status: "connected" } }));
  assert.ok(!prod.some((x) => x.planned_action?.action_type === "AUTO_PUBLISH"));
  assert.deepEqual(autoPublishBlockers(arts[0]), []);
});

test("safe auto-publish respects the weekly publication limit", () => {
  const base = { managed: true, status: "awaiting_approval", current_version: 1, qa_status: "PASS", qa_score: 95, fact_check_status: "passed", flags: [] };
  const c = ctx({ policy: { auto_publish_safe: true, max_publications_per_week: 1 }, articles: [{ ...base, id: "x1" }, { ...base, id: "x2" }] });
  const d = run(c);
  const ok = d.filter((x) => x.planned_action?.action_type === "AUTO_PUBLISH" && !x.planned_action.blocked);
  const blocked = d.filter((x) => x.planned_action?.action_type === "AUTO_PUBLISH" && x.planned_action.blocked);
  assert.equal(ok.length, 1);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].block_code, "BUDGET_LIMIT");
});

// ---------------------------------------------------------------- monthly packages
test("monthly packages: 7/15/30 posts spread evenly over the month", async () => {
  const { planDays } = await import("../src/decide.js");
  assert.deepEqual(planDays(7, 30), [1, 5, 9, 13, 18, 22, 26]);
  assert.equal(planDays(15, 30).length, 15);
  assert.deepEqual(planDays(15, 30).slice(0, 4), [1, 3, 5, 7]);
  assert.deepEqual(planDays(30, 30), Array.from({ length: 30 }, (_, i) => i + 1));
  assert.equal(planDays(30, 28).length, 28); // February: never more than 1/day
  assert.deepEqual(planDays(0, 30), []);
});

test("monthly packages: generation waits for the next planned day and stops at the package size", async () => {
  const { monthlyPlanCheck } = await import("../src/decide.js");
  const tz = "America/Ciudad_Juarez";
  const at = (d) => Date.parse(`2026-09-${String(d).padStart(2, "0")}T15:00:00Z`); // 9:00 Juárez
  const p7 = { posts_per_month: 7, timezone: tz }; // days 1,5,9,13,18,22,26
  assert.equal(monthlyPlanCheck(p7, at(1), 0), null);
  assert.equal(monthlyPlanCheck(p7, at(2), 1).code, "PLAN_NOT_DUE");
  assert.match(monthlyPlanCheck(p7, at(2), 1).detail, /next post on day 5/);
  assert.equal(monthlyPlanCheck(p7, at(5), 1), null);
  assert.equal(monthlyPlanCheck(p7, at(10), 1), null); // behind schedule → catch up (max 1/day still applies)
  assert.equal(monthlyPlanCheck(p7, at(29), 7).code, "PLAN_LIMIT");
  assert.equal(monthlyPlanCheck({ posts_per_month: 0 }, at(3), 99), null); // no package → legacy limits only
  const p30 = { posts_per_month: 30, timezone: tz };
  assert.equal(monthlyPlanCheck(p30, at(12), 11), null);
  assert.equal(monthlyPlanCheck(p30, at(12), 12).code, "PLAN_NOT_DUE");
});

test("monthly packages: budget gate applies the plan to GENERATE_CONTENT only", async () => {
  const { budgetCheck } = await import("../src/decide.js");
  const now = Date.parse("2026-09-02T15:00:00Z");
  const ctx = {
    now,
    policy: { ...policy(), posts_per_month: 7, timezone: "America/Ciudad_Juarez", max_content_jobs_per_day: 1, max_content_jobs_per_week: 7 },
    usage: { actions_today: 0, content_today: 0, content_week: 1, content_month: 1, publications_week: 0, strategy_week: 0, crawls_week: 0, ai_calls_today: 0, ai_tokens_today: 0, ai_cost_today: { known: 0 }, ai_cost_month: { known: 0 } },
    estimates: { content_job: { calls: null, tokens: null, cost: null } },
  };
  assert.equal(budgetCheck("GENERATE_CONTENT", ctx, []).code, "PLAN_NOT_DUE");
  assert.equal(budgetCheck("PUBLISH", ctx, []), null);
});
