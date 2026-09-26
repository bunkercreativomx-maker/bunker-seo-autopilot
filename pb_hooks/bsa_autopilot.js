// Bunker SEO Autopilot — Phase 7 orchestration (trusted server side).
//
// User endpoints (/api/bsa/autopilot/*) run as the signed-in user: tenant and
// role come from the database record behind the token, never from the body.
// Internal endpoints (/api/bsa/internal/autopilot/*) are for the independent
// bunker-seo-autopilot worker only (PocketBase superuser).
//
// Autopilot COORDINATES existing workflows. Every execution below delegates to
// the Phase 2–5 entry points (crawl_jobs / strategy_jobs queue, bsa_lib
// startGeneration / retryGeneration / requestRevision / requestRecheck,
// bsa_publish requestPublish / requestVerify / preview) so their validation,
// approval lock, idempotency and tenant checks stay authoritative. Nothing in
// this file approves content, verifies business facts or edits a website.
//
// JSVM: handlers run in isolated VMs; require this file inside each handler.

const MODES = ["OFF", "OBSERVE", "SUPERVISED"]; // FULL_AUTO reserved (feature flag, never enabled in Phase 7)
const SCHEDULES = ["daily", "weekly", "manual_only"];
const ACTION_TYPES = ["CRAWL", "STRATEGY_REFRESH", "GENERATE_CONTENT", "RECHECK_CONTENT", "REQUEST_REVISION", "PUBLISH", "VERIFY_PUBLICATION", "UPDATE_PUBLICATION", "AUTO_PUBLISH", "CREATE_ANALYTICS_OPPORTUNITY", "NOTIFY_HUMAN", "WAIT"];

// Safe auto-publish rule (must match autopilot-worker/src/decide.js). Re-checked
// here at execution time, fail-closed.
const AUTO_PUBLISH_MIN_SCORE = 85;
const HARMLESS_FLAGS = ["RESEARCH_LIMITED", "META_DESCRIPTION_LENGTH", "SEO_TITLE_LENGTH", "SEO_TITLE_KEYWORD", "SLUG_FORMAT", "MINOR_ADVISORY", "NOT_REQUIRED", "NOT_APPLICABLE"];
function autoPublishBlockers(a) {
  const b = [];
  if (a.status !== "awaiting_approval") b.push("status " + a.status);
  if (a.qa_status !== "PASS") b.push("QA " + (a.qa_status || "pending"));
  const r = a.qa_score;
  const sc = typeof r === "number" ? r : (r && typeof r === "object" && typeof r.score === "number" ? r.score : null);
  if (sc === null || Math.round(sc) < AUTO_PUBLISH_MIN_SCORE) b.push("score " + sc + " < " + AUTO_PUBLISH_MIN_SCORE);
  if (a.fact_check_status !== "passed") b.push("fact check " + (a.fact_check_status || "pending"));
  if (a.high_risk) b.push("sensitive topic");
  if (Array.isArray(a.risk_categories) && a.risk_categories.length) b.push("risk categories");
  const flags = Array.isArray(a.flags) ? a.flags : [];
  for (const f of flags) {
    const code = typeof f === "string" ? f : (f && (f.code || f.type)) || JSON.stringify(f);
    if (HARMLESS_FLAGS.indexOf(code) === -1) b.push("flag " + code);
  }
  return b;
}
const ENVIRONMENTS = ["staging", "production"];
const HOT_RUN = ["queued", "collecting_signals", "evaluating", "planning", "executing"];
const PARKED_RUN = ["waiting_for_approval", "monitoring"];
const TERMINAL_RUN = ["completed", "completed_with_warnings", "failed", "cancelled"];
const RUN_TRANSITIONS = {
  queued: ["collecting_signals", "paused", "cancelled", "failed"],
  collecting_signals: ["evaluating", "paused", "cancelled", "failed"],
  evaluating: ["planning", "completed", "completed_with_warnings", "paused", "cancelled", "failed"],
  planning: ["executing", "completed", "completed_with_warnings", "paused", "cancelled", "failed"],
  executing: ["waiting_for_approval", "monitoring", "completed", "completed_with_warnings", "paused", "cancelled", "failed"],
  waiting_for_approval: ["evaluating", "executing", "monitoring", "completed", "completed_with_warnings", "paused", "cancelled", "failed"],
  monitoring: ["evaluating", "executing", "waiting_for_approval", "completed", "completed_with_warnings", "paused", "cancelled", "failed"],
  paused: ["executing", "waiting_for_approval", "monitoring", "cancelled", "completed_with_warnings"],
  completed: [], completed_with_warnings: [], failed: [], cancelled: [],
};
const ACTION_TRANSITIONS = {
  planned: ["queued", "running", "waiting_for_approval", "blocked", "skipped", "cancelled", "completed", "failed"],
  blocked: ["planned", "skipped", "cancelled"],
  waiting_for_approval: ["queued", "running", "completed", "completed_with_warnings", "cancelled", "skipped", "failed", "blocked"],
  queued: ["running", "completed", "completed_with_warnings", "failed", "cancelled"],
  running: ["completed", "completed_with_warnings", "failed", "cancelled"],
  completed: [], completed_with_warnings: [], failed: [], skipped: [], cancelled: [],
};

// Safe defaults (spec §9): OFF, disabled, every pause guard on, human publish
// approval required, publish-after-approval false, staging only.
const DEFAULT_POLICY = {
  enabled: false, mode: "OFF", paused: false, schedule: "weekly",
  allowed_actions: ["CRAWL", "STRATEGY_REFRESH", "GENERATE_CONTENT", "RECHECK_CONTENT", "REQUEST_REVISION", "PUBLISH", "VERIFY_PUBLICATION", "UPDATE_PUBLICATION", "NOTIFY_HUMAN", "WAIT"],
  allowed_environments: ["staging"],
  max_actions_per_day: 10, max_content_jobs_per_day: 1, max_content_jobs_per_week: 3, max_publications_per_week: 3,
  max_revision_jobs_per_article: 1, max_strategy_refresh_per_week: 1, max_crawls_per_week: 1,
  max_ai_budget_daily: 5, max_ai_budget_monthly: 50, max_ai_calls_daily: 60, max_ai_tokens_daily: 2000000,
  require_human_publish_approval: true, publish_after_human_approval: false,
  pause_on_high_risk: true, pause_on_fact_failure: true, pause_on_integration_error: true,
  cooldown_hours: 24, optimization_cooldown_days: 28, crawl_max_age_days: 14, strategy_max_age_days: 30,
  approval_reminder_days: 3, timezone: "America/Ciudad_Juarez",
  // Simple mode: Autopilot picks the next best Phase 3 topic itself (topic
  // selection only — the generated ARTICLE still needs human approval).
  auto_pick_opportunities: false,
  auto_publish_safe: false,
};
const LIMIT_BOUNDS = {
  max_actions_per_day: [0, 50], max_content_jobs_per_day: [0, 5], max_content_jobs_per_week: [0, 20], max_publications_per_week: [0, 20],
  max_revision_jobs_per_article: [0, 2], max_strategy_refresh_per_week: [0, 3], max_crawls_per_week: [0, 7],
  max_ai_calls_daily: [0, 1000], max_ai_tokens_daily: [0, 20000000], cooldown_hours: [1, 720], optimization_cooldown_days: [1, 365],
  crawl_max_age_days: [1, 365], strategy_max_age_days: [1, 365], approval_reminder_days: [1, 60],
};
const MONEY_BOUNDS = { max_ai_budget_daily: [0, 500], max_ai_budget_monthly: [0, 5000] };

function lib() { return require(`${__hooks}/bsa_lib.js`); }

function isAdmin(actor) { return actor.role === "admin" || actor.role === "super_admin"; }

function assertAutopilotAdmin(actor) {
  if (!isAdmin(actor)) lib().fail(403, "FORBIDDEN", "Only organization admins can change Autopilot.");
}

function websiteFor(actor, websiteId) {
  const L = lib();
  const w = L.getOne("websites", String(websiteId || ""));
  if (!w || w.organization !== actor.organization) L.fail(404, "NOT_FOUND", "Website not found.");
  const c = L.getOne("clients", String(w.client || ""));
  if (!c || c.organization !== actor.organization) L.fail(404, "NOT_FOUND", "Website not found.");
  return w;
}

function policyOf(websiteId, app) {
  return lib().findFirst("autopilot_policies", "website = {:w}", "", { w: websiteId }, app);
}

function controlOf(orgId, app) {
  return lib().findFirst("autopilot_controls", "organization = {:o}", "", { o: orgId }, app);
}

function orgPaused(orgId) {
  const c = controlOf(orgId);
  return Boolean(c && c.paused);
}

function publicPolicy(p, website) {
  const out = {};
  const src = p || DEFAULT_POLICY;
  for (const k of Object.keys(DEFAULT_POLICY)) out[k] = src[k] === undefined || src[k] === null || src[k] === "" ? DEFAULT_POLICY[k] : src[k];
  out.id = p ? p.id : "";
  out.exists = Boolean(p);
  out.version = p ? Number(p.version || 0) : 0;
  out.next_run_at = p ? p.next_run_at || "" : "";
  out.last_run_at = p ? p.last_run_at || "" : "";
  out.website = website.id;
  out.full_auto_available = false;
  return out;
}

function nextRunFrom(schedule, from) {
  if (schedule === "manual_only") return "";
  if (schedule === "daily") {
    // Daily posts: next morning ~7:00 Ciudad Juárez (13:00 UTC).
    const d = new Date(from ? Date.parse(from) : Date.now());
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 13, 0, 0));
    if (next.getTime() <= d.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString();
  }
  const ms = 7 * 86400000;
  return new Date((from ? Date.parse(from) : Date.now()) + ms).toISOString();
}

function ensurePolicy(tx, website, actor) {
  const existing = policyOf(website.id, tx);
  if (existing) return existing;
  const L = lib();
  const ts = L.now();
  const data = Object.assign({}, DEFAULT_POLICY, {
    organization: website.organization, client: website.client, website: website.id, version: 1,
    created_by: actor.id, updated_by: actor.id, created_at: ts, updated_at: ts,
  });
  return L.createRec("autopilot_policies", data, tx);
}

function intIn(v, key) {
  const b = LIMIT_BOUNDS[key];
  const n = Number(v);
  if (!Number.isFinite(n) || Math.floor(n) !== n || n < b[0] || n > b[1]) lib().fail(400, "INVALID", key + " must be an integer between " + b[0] + " and " + b[1] + ".");
  return n;
}

function moneyIn(v, key) {
  const b = MONEY_BOUNDS[key];
  const n = Number(v);
  if (!Number.isFinite(n) || n < b[0] || n > b[1]) lib().fail(400, "INVALID", key + " must be between " + b[0] + " and " + b[1] + ".");
  return Math.round(n * 100) / 100;
}

function validatePolicyInput(body, current) {
  const L = lib();
  const out = {};
  if (body.mode !== undefined) {
    const mode = String(body.mode);
    if (mode === "FULL_AUTO") L.fail(400, "FEATURE_DISABLED", "FULL_AUTO is reserved and disabled in Phase 7.");
    if (MODES.indexOf(mode) === -1) L.fail(400, "INVALID", "Invalid mode.");
    out.mode = mode;
  }
  if (body.schedule !== undefined) {
    if (SCHEDULES.indexOf(String(body.schedule)) === -1) L.fail(400, "INVALID", "Invalid schedule.");
    out.schedule = String(body.schedule);
  }
  if (body.allowedActions !== undefined) {
    const list = Array.isArray(body.allowedActions) ? body.allowedActions : String(body.allowedActions || "").split(/[\s,]+/);
    const clean = [];
    for (const a of list) {
      const v = String(a || "").trim();
      if (!v) continue;
      if (ACTION_TYPES.indexOf(v) === -1) L.fail(400, "INVALID", "Unknown action type: " + v);
      if (clean.indexOf(v) === -1) clean.push(v);
    }
    out.allowed_actions = clean;
  }
  if (body.allowedEnvironments !== undefined) {
    const list = Array.isArray(body.allowedEnvironments) ? body.allowedEnvironments : [body.allowedEnvironments];
    const clean = [];
    for (const e of list) {
      const v = String(e || "").trim();
      if (!v) continue;
      if (ENVIRONMENTS.indexOf(v) === -1) L.fail(400, "INVALID", "Unknown environment: " + v);
      if (clean.indexOf(v) === -1) clean.push(v);
    }
    out.allowed_environments = clean;
  }
  for (const k of Object.keys(LIMIT_BOUNDS)) {
    const camel = k.replace(/_([a-z])/g, function (_, c) { return c.toUpperCase(); });
    if (body[camel] !== undefined) out[k] = intIn(body[camel], k);
  }
  for (const k of Object.keys(MONEY_BOUNDS)) {
    const camel = k.replace(/_([a-z])/g, function (_, c) { return c.toUpperCase(); });
    if (body[camel] !== undefined) out[k] = moneyIn(body[camel], k);
  }
  if (body.publishAfterHumanApproval !== undefined) out.publish_after_human_approval = body.publishAfterHumanApproval === true;
  if (body.autoPickOpportunities !== undefined) out.auto_pick_opportunities = body.autoPickOpportunities === true;
  if (body.autoPublishSafe !== undefined) out.auto_publish_safe = body.autoPublishSafe === true;
  // Phase 7 invariants: human publish approval and pause guards cannot be disabled.
  if (body.requireHumanPublishApproval === false) L.fail(400, "INVALID", "Human publish approval cannot be disabled in Phase 7.");
  if (body.pauseOnHighRisk === false) L.fail(400, "INVALID", "High-risk content always stops Autopilot in Phase 7.");
  for (const f of [["pauseOnFactFailure", "pause_on_fact_failure"], ["pauseOnIntegrationError", "pause_on_integration_error"]]) if (body[f[0]] !== undefined) out[f[1]] = body[f[0]] === true;
  if (body.timezone !== undefined) {
    const tz = L.clean(body.timezone, 60);
    if (!/^[A-Za-z_]+(\/[A-Za-z_+\-0-9]+)*$/.test(tz)) L.fail(400, "INVALID", "Invalid timezone.");
    out.timezone = tz;
  }
  const merged = Object.assign({}, current, out);
  if (merged.max_content_jobs_per_day > merged.max_content_jobs_per_week) L.fail(400, "INVALID", "Daily content limit cannot exceed the weekly limit.");
  if (merged.max_ai_budget_daily > merged.max_ai_budget_monthly) L.fail(400, "INVALID", "Daily AI budget cannot exceed the monthly budget.");
  out.require_human_publish_approval = true;
  out.pause_on_high_risk = true;
  return out;
}

// Consequences shown before saving (spec §71). Pure; no side effects.
function consequences(p, website) {
  const can = [];
  const cannot = ["Approve content or business facts", "Publish without a recorded human approval", "Change website code, DNS, robots.txt or repositories", "Change the publishing target, credentials or billing"];
  const allowed = p.allowed_actions || [];
  if (!p.enabled || p.mode === "OFF") can.push("Nothing — Autopilot is OFF");
  else if (p.mode === "OBSERVE") can.push("Detect signals and record recommendations (no jobs are started)");
  else {
    if (allowed.indexOf("CRAWL") !== -1) can.push("Refresh a stale crawl (max " + p.max_crawls_per_week + "/week)");
    if (allowed.indexOf("STRATEGY_REFRESH") !== -1) can.push("Refresh a stale strategy (max " + p.max_strategy_refresh_per_week + "/week)");
    if (allowed.indexOf("GENERATE_CONTENT") !== -1) can.push("Generate drafts from " + (p.auto_pick_opportunities ? "the best Phase 3 topics it picks itself" : "APPROVED opportunities") + " (max " + p.max_content_jobs_per_day + "/day, " + p.max_content_jobs_per_week + "/week)");
    if (allowed.indexOf("REQUEST_REVISION") !== -1) can.push("Request up to " + p.max_revision_jobs_per_article + " automatic Phase 4 revision(s) per article");
    if (allowed.indexOf("RECHECK_CONTENT") !== -1) can.push("Re-run fact check / QA on drafts");
  }
  const env = website.publishing_environment || "not configured";
  const envAllowed = (p.allowed_environments || []).indexOf(website.publishing_environment) !== -1;
  const autoPublish = Boolean(p.enabled && p.mode === "SUPERVISED" && p.publish_after_human_approval && allowed.indexOf("PUBLISH") !== -1 && envAllowed);
  return {
    mode: p.mode, enabled: Boolean(p.enabled), can: can, cannot: cannot,
    publish_after_human_approval: autoPublish,
    publish_explanation: autoPublish
      ? "After a human approves an article, Autopilot will publish THAT approved version to the configured " + env + " target. High-risk content always waits for a manual Publish."
      : "Autopilot never publishes by itself. After approval a human must press Publish" + (p.publish_after_human_approval && !envAllowed ? " (publishing environment '" + env + "' is not allowed by this policy)" : "") + ".",
    publishing_environment: env,
    budgets: { ai_calls_daily: p.max_ai_calls_daily, ai_tokens_daily: p.max_ai_tokens_daily, ai_budget_daily: p.max_ai_budget_daily, ai_budget_monthly: p.max_ai_budget_monthly, note: "Dollar budgets apply only where model pricing is configured; otherwise cost is reported as unknown and call/token limits apply." },
    schedule: p.schedule,
  };
}

function audit(tx, actor, website, action, entityType, entityId, metadata) {
  lib().logActivity(tx, { organization: website.organization, client: website.client, website: website.id, user: actor ? actor.id : "", action: action, entity_type: entityType, entity_id: entityId, metadata: metadata || {} });
}

// ---------------------------------------------------------------- user endpoints

function getPolicy(actor, body) {
  const w = websiteFor(actor, body.websiteId);
  const p = policyOf(w.id);
  const pub = publicPolicy(p, w);
  return { policy: pub, consequences: consequences(pub, w), organization_paused: orgPaused(actor.organization), can_edit: isAdmin(actor) };
}

function previewPolicy(actor, body) {
  const w = websiteFor(actor, body.websiteId);
  const current = publicPolicy(policyOf(w.id), w);
  const changes = validatePolicyInput(body, current);
  if (body.enabled !== undefined) changes.enabled = body.enabled === true;
  const next = Object.assign({}, current, changes);
  return { consequences: consequences(next, w), policy: next };
}

function savePolicy(actor, body) {
  assertAutopilotAdmin(actor);
  const L = lib();
  const w = websiteFor(actor, body.websiteId);
  const expected = body.expectedVersion === undefined ? null : Number(body.expectedVersion);
  let result = null;
  $app.runInTransaction(function (tx) {
    const p = ensurePolicy(tx, w, actor);
    if (expected !== null && expected !== Number(p.version || 0) && Number(p.version || 0) > 1) L.fail(409, "CONFLICT", "The policy changed since you opened it. Reload and try again.");
    const current = publicPolicy(p, w);
    const changes = validatePolicyInput(body, current);
    const wasEnabled = Boolean(p.enabled) && p.mode !== "OFF";
    if (body.enabled !== undefined) changes.enabled = body.enabled === true;
    const next = Object.assign({}, current, changes);
    if (next.enabled && next.mode === "OFF") L.fail(400, "INVALID", "Choose OBSERVE or SUPERVISED to enable Autopilot.");
    if (!next.enabled) changes.mode = next.mode; // keep chosen mode for later, inert while disabled
    const nowEnabled = Boolean(next.enabled) && next.mode !== "OFF";
    if (changes.publish_after_human_approval === true && !p.publish_after_human_approval) changes.publish_after_approval_since = L.now();
    if (nowEnabled && (!p.next_run_at || changes.schedule !== undefined || !wasEnabled)) changes.next_run_at = nextRunFrom(next.schedule);
    if (!nowEnabled) changes.next_run_at = "";
    changes.version = Number(p.version || 0) + 1;
    changes.updated_by = actor.id;
    changes.updated_at = L.now();
    const updated = L.updateRec("autopilot_policies", p.id, changes, tx);
    const diff = {};
    for (const k of Object.keys(changes)) if (["updated_at", "updated_by", "version", "next_run_at"].indexOf(k) === -1 && JSON.stringify(changes[k]) !== JSON.stringify(p[k])) diff[k] = { from: p[k] === undefined ? null : p[k], to: changes[k] };
    let action = "AUTOPILOT_POLICY_UPDATED";
    if (!wasEnabled && nowEnabled) action = "AUTOPILOT_ENABLED";
    else if (wasEnabled && !nowEnabled) action = "AUTOPILOT_DISABLED";
    audit(tx, actor, w, action, "autopilot_policy", p.id, { changes: diff, version: changes.version, mode: next.mode, enabled: Boolean(next.enabled) });
    if (action !== "AUTOPILOT_POLICY_UPDATED" && Object.keys(diff).length > 2) audit(tx, actor, w, "AUTOPILOT_POLICY_UPDATED", "autopilot_policy", p.id, { changes: diff, version: changes.version });
    result = updated;
  });
  const pub = publicPolicy(result, w);
  return { policy: pub, consequences: consequences(pub, w) };
}

function setWebsitePause(actor, body, paused) {
  assertAutopilotAdmin(actor);
  const L = lib();
  const w = websiteFor(actor, body.websiteId);
  const reason = L.clean(body.reason, 500);
  $app.runInTransaction(function (tx) {
    const p = ensurePolicy(tx, w, actor);
    if (Boolean(p.paused) === paused) return;
    L.updateRec("autopilot_policies", p.id, { paused: paused, paused_reason: paused ? (reason || "Paused by admin") : "", paused_at: paused ? L.now() : "", updated_by: actor.id, updated_at: L.now(), version: Number(p.version || 0) + 1 }, tx);
    if (paused) {
      // Hot runs stop at the next safe step (the worker re-checks the policy
      // between steps). Planned (not yet executed) actions are blocked.
      const hot = L.findMany("autopilot_runs", "website = {:w} && dry_run = false && (" + HOT_RUN.map(function (s) { return "status = '" + s + "'"; }).join(" || ") + ")", "", 20, { w: w.id }, tx);
      for (const r of hot) L.updateRec("autopilot_runs", r.id, { status: "paused", current_step: "paused by admin", reason: "Paused by admin", updated_at: L.now() }, tx);
      const planned = L.findMany("autopilot_actions", "website = {:w} && status = 'planned'", "", 100, { w: w.id }, tx);
      for (const a of planned) L.updateRec("autopilot_actions", a.id, { status: "blocked", error_class: "POLICY", error_code: "AUTOPILOT_PAUSED", error_message: "Autopilot paused by admin.", updated_at: L.now() }, tx);
    }
    if (!paused) {
      // Runs stopped by the pause are closed (not silently continued); the
      // next trigger/schedule starts a fresh evaluation with the live policy.
      const stopped = L.findMany("autopilot_runs", "website = {:w} && status = 'paused'", "", 50, { w: w.id }, tx);
      for (const r of stopped) L.updateRec("autopilot_runs", r.id, { status: "completed_with_warnings", reason: "Stopped by pause; superseded after resume", completed_at: L.now(), updated_at: L.now() }, tx);
    }
    audit(tx, actor, w, paused ? "AUTOPILOT_PAUSED" : "AUTOPILOT_RESUMED", "autopilot_policy", p.id, { scope: "website", reason: reason });
  });
  return getPolicy(actor, body);
}

function setOrgPause(actor, body, paused) {
  assertAutopilotAdmin(actor);
  const L = lib();
  const reason = L.clean(body.reason, 500);
  $app.runInTransaction(function (tx) {
    let c = controlOf(actor.organization, tx);
    const ts = L.now();
    if (!c) c = L.createRec("autopilot_controls", { organization: actor.organization, paused: false, created_at: ts, updated_at: ts }, tx);
    if (Boolean(c.paused) === paused) return;
    const patch = paused ? { paused: true, reason: reason || "Organization kill switch", paused_by: actor.id, paused_at: ts, updated_at: ts } : { paused: false, resumed_by: actor.id, resumed_at: ts, updated_at: ts };
    L.updateRec("autopilot_controls", c.id, patch, tx);
    if (paused) {
      const hot = L.findMany("autopilot_runs", "organization = {:o} && dry_run = false && (" + HOT_RUN.map(function (s) { return "status = '" + s + "'"; }).join(" || ") + ")", "", 200, { o: actor.organization }, tx);
      for (const r of hot) L.updateRec("autopilot_runs", r.id, { status: "paused", current_step: "organization kill switch", reason: "AUTOPILOT_PAUSED (organization)", updated_at: ts }, tx);
      const planned = L.findMany("autopilot_actions", "organization = {:o} && status = 'planned'", "", 500, { o: actor.organization }, tx);
      for (const a of planned) L.updateRec("autopilot_actions", a.id, { status: "blocked", error_class: "POLICY", error_code: "AUTOPILOT_PAUSED", error_message: "Organization kill switch.", updated_at: ts }, tx);
    }
    if (!paused) {
      const stopped = L.findMany("autopilot_runs", "organization = {:o} && status = 'paused'", "", 200, { o: actor.organization }, tx);
      for (const r of stopped) {
        const wp = policyOf(r.website, tx);
        if (wp && wp.paused) continue;
        L.updateRec("autopilot_runs", r.id, { status: "completed_with_warnings", reason: "Stopped by organization kill switch; superseded after resume", completed_at: ts, updated_at: ts }, tx);
      }
    }
    L.logActivity(tx, { organization: actor.organization, user: actor.id, action: paused ? "AUTOPILOT_PAUSED" : "AUTOPILOT_RESUMED", entity_type: "autopilot_control", entity_id: c.id, metadata: { scope: "organization", reason: reason } });
  });
  const c = controlOf(actor.organization);
  return { organization_paused: Boolean(c && c.paused) };
}

function requestRun(actor, body, dryRun) {
  const L = lib();
  // Dry run is read-only evaluation: content writers may request it. A real
  // run starts orchestration and is admin-only.
  if (!dryRun) assertAutopilotAdmin(actor);
  else if (actor.role === "viewer" || actor.role === "client") L.fail(403, "FORBIDDEN", "You do not have permission to run Autopilot.");
  const w = websiteFor(actor, body.websiteId);
  const p = policyOf(w.id);
  if (!dryRun) {
    if (!p || !p.enabled || p.mode === "OFF") L.fail(409, "AUTOPILOT_OFF", "Autopilot is OFF for this website. Enable OBSERVE or SUPERVISED first.");
    if (p.paused) L.fail(409, "AUTOPILOT_PAUSED", "Autopilot is paused for this website.");
    if (orgPaused(actor.organization)) L.fail(409, "AUTOPILOT_PAUSED", "Autopilot is paused for the organization (kill switch).");
    const hot = L.findFirst("autopilot_runs", "website = {:w} && dry_run = false && (" + HOT_RUN.map(function (s) { return "status = '" + s + "'"; }).join(" || ") + ")", "", { w: w.id });
    if (hot) return { run: { id: hot.id, status: hot.status }, created: false, merged: true };
  } else {
    const pendingDry = L.findFirst("autopilot_runs", "website = {:w} && dry_run = true && status = 'queued'", "", { w: w.id });
    if (pendingDry) return { run: { id: pendingDry.id, status: pendingDry.status }, created: false };
  }
  const ts = L.now();
  let run = null;
  try {
    $app.runInTransaction(function (tx) {
      run = L.createRec("autopilot_runs", {
        organization: w.organization, client: w.client, website: w.id, policy: p ? p.id : "", trigger: dryRun ? "dry_run" : "manual",
        dry_run: Boolean(dryRun), status: "queued", mode: p ? p.mode : "OFF", current_step: "queued", signal_count: 0, decision_count: 0, action_count: 0,
        requested_by: actor.id, created_at: ts, updated_at: ts,
      }, tx);
      audit(tx, actor, w, dryRun ? "AUTOPILOT_DRY_RUN_REQUESTED" : "AUTOPILOT_RUN_REQUESTED", "autopilot_run", run.id, { trigger: dryRun ? "dry_run" : "manual" });
    });
  } catch (err) {
    const again = L.findFirst("autopilot_runs", "website = {:w} && dry_run = false && (" + HOT_RUN.map(function (s) { return "status = '" + s + "'"; }).join(" || ") + ")", "", { w: w.id });
    if (again) return { run: { id: again.id, status: again.status }, created: false, merged: true };
    throw err;
  }
  return { run: { id: run.id, status: run.status }, created: true };
}

function signalFor(actor, id) {
  const L = lib();
  const s = L.getOne("autopilot_signals", String(id || ""));
  if (!s || s.organization !== actor.organization) L.fail(404, "NOT_FOUND", "Signal not found.");
  websiteFor(actor, s.website);
  return s;
}

function decideSignal(actor, body) {
  const L = lib();
  if (actor.role === "viewer" || actor.role === "client") L.fail(403, "FORBIDDEN", "You do not have permission to change signals.");
  const s = signalFor(actor, body.signalId);
  const op = String(body.operation || "");
  const w = L.getOne("websites", s.website);
  const patch = { decided_by: actor.id, updated_at: L.now() };
  if (op === "ignore") { patch.status = "ignored"; patch.status_reason = L.clean(body.reason, 500) || "Ignored permanently by user"; patch.snoozed_until = ""; }
  else if (op === "snooze") {
    const days = Number(body.days);
    if ([7, 30, 90].indexOf(days) === -1) L.fail(400, "INVALID", "Snooze must be 7, 30 or 90 days.");
    patch.status = "snoozed"; patch.snoozed_until = new Date(Date.now() + days * 86400000).toISOString(); patch.status_reason = "Snoozed " + days + " days by user";
  } else if (op === "restore") { patch.status = "active"; patch.snoozed_until = ""; patch.status_reason = "Restored by user"; }
  else L.fail(400, "INVALID", "Unsupported operation.");
  $app.runInTransaction(function (tx) {
    L.updateRec("autopilot_signals", s.id, patch, tx);
    audit(tx, actor, w, op === "ignore" ? "AUTOPILOT_SIGNAL_IGNORED" : op === "snooze" ? "AUTOPILOT_SIGNAL_SNOOZED" : "AUTOPILOT_SIGNAL_RESTORED", "autopilot_signal", s.id, { signal_type: s.signal_type, dedup_key: s.dedup_key, until: patch.snoozed_until || null });
  });
  return { ok: true, status: patch.status };
}

function cancelAction(actor, body) {
  const L = lib();
  if (actor.role === "viewer" || actor.role === "client") L.fail(403, "FORBIDDEN", "You do not have permission to cancel Autopilot actions.");
  const a = L.getOne("autopilot_actions", String(body.actionId || ""));
  if (!a || a.organization !== actor.organization) L.fail(404, "NOT_FOUND", "Action not found.");
  const w = websiteFor(actor, a.website);
  if (["planned", "blocked", "waiting_for_approval"].indexOf(a.status) === -1) L.fail(409, "INVALID_STATE", "Only planned, blocked or waiting actions can be cancelled (status is " + a.status + ").");
  $app.runInTransaction(function (tx) {
    L.updateRec("autopilot_actions", a.id, { status: "cancelled", error_class: "POLICY", error_code: "CANCELLED_BY_USER", error_message: "Cancelled by " + (actor.name || actor.email), completed_at: L.now(), updated_at: L.now() }, tx);
    L.createRec("autopilot_run_events", { organization: a.organization, client: a.client, website: a.website, run: a.run, action: a.id, kind: "action_cancelled", message: a.action_type + " cancelled by " + L.clean(actor.name || actor.email, 120), details: {}, at: L.now() }, tx);
    // Rejection memory: a cancelled action's signal is snoozed so the next run
    // does not recreate it immediately.
    if (a.decision) {
      const d = L.getOne("autopilot_decisions", a.decision, tx);
      if (d && d.signal) {
        const s = L.getOne("autopilot_signals", d.signal, tx);
        if (s && s.status === "active") L.updateRec("autopilot_signals", s.id, { status: "snoozed", snoozed_until: new Date(Date.now() + 30 * 86400000).toISOString(), status_reason: "Action cancelled by user", decided_by: actor.id, updated_at: L.now() }, tx);
      }
    }
    audit(tx, actor, w, "AUTOPILOT_ACTION_CANCELLED", "autopilot_action", a.id, { action_type: a.action_type, run: a.run });
    L.createRec("autopilot_triggers", { organization: a.organization, client: a.client, website: a.website, trigger: "follow_up", entity_type: "autopilot_action", entity_id: a.id, payload: { reason: "action_cancelled" }, dedup_key: "action_cancelled:" + a.id, status: "pending", created_at: L.now(), updated_at: L.now() }, tx);
  });
  return { ok: true };
}

function resolveTask(actor, body) {
  const L = lib();
  if (actor.role === "viewer" || actor.role === "client") L.fail(403, "FORBIDDEN", "You do not have permission to resolve tasks.");
  const t = L.getOne("autopilot_tasks", String(body.taskId || ""));
  if (!t || t.organization !== actor.organization) L.fail(404, "NOT_FOUND", "Task not found.");
  const w = websiteFor(actor, t.website);
  const status = body.operation === "dismiss" ? "dismissed" : "done";
  $app.runInTransaction(function (tx) {
    L.updateRec("autopilot_tasks", t.id, { status: status, resolved_by: actor.id, resolved_at: L.now(), updated_at: L.now() }, tx);
    audit(tx, actor, w, "AUTOPILOT_TASK_RESOLVED", "autopilot_task", t.id, { kind: t.kind, status: status });
  });
  return { ok: true };
}

function resetCircuit(actor, body) {
  assertAutopilotAdmin(actor);
  const L = lib();
  const c = L.getOne("autopilot_circuits", String(body.circuitId || ""));
  if (!c || c.organization !== actor.organization) L.fail(404, "NOT_FOUND", "Circuit not found.");
  const w = websiteFor(actor, c.website);
  $app.runInTransaction(function (tx) {
    L.updateRec("autopilot_circuits", c.id, { state: "closed", consecutive_failures: 0, closed_at: L.now(), updated_at: L.now() }, tx);
    audit(tx, actor, w, "AUTOPILOT_CIRCUIT_CLOSED", "autopilot_circuit", c.id, { action_type: c.action_type });
  });
  return { ok: true };
}

// ---------------------------------------------------------------- internal (worker, superuser)

function assertTransition(table, from, to, label) {
  const allowed = table[from];
  if (!allowed || allowed.indexOf(to) === -1) lib().fail(409, "INVALID_TRANSITION", label + " cannot move from " + from + " to " + to + ".");
}

// Atomic lease acquisition inside one SQLite write transaction.
function internalLease(body) {
  const L = lib();
  const runId = String(body.runId || "");
  const owner = L.clean(body.owner, 100);
  const seconds = Math.max(10, Math.min(900, Number(body.seconds || 120) | 0));
  if (!owner) L.fail(400, "INVALID", "owner required");
  let out = null;
  $app.runInTransaction(function (tx) {
    const r = L.getOne("autopilot_runs", runId, tx);
    if (!r) L.fail(404, "NOT_FOUND", "run not found");
    const now = Date.now();
    const held = r.lease_owner && r.lease_until && Date.parse(String(r.lease_until).replace(" ", "T")) > now;
    if (body.release === true) {
      if (r.lease_owner === owner) L.updateRec("autopilot_runs", r.id, { lease_owner: "", lease_until: "", updated_at: L.now() }, tx);
      out = { released: true };
      return;
    }
    if (held && r.lease_owner !== owner) { out = { acquired: false, owner: r.lease_owner, lease_until: r.lease_until }; return; }
    const until = new Date(now + seconds * 1000).toISOString();
    L.updateRec("autopilot_runs", r.id, { lease_owner: owner, lease_until: until, updated_at: L.now() }, tx);
    out = { acquired: true, lease_until: until };
  });
  return out;
}

function internalTransition(body) {
  const L = lib();
  const kind = String(body.kind || "");
  const id = String(body.id || "");
  const to = String(body.to || "");
  const patch = body.patch && typeof body.patch === "object" ? body.patch : {};
  const collection = kind === "run" ? "autopilot_runs" : kind === "action" ? "autopilot_actions" : "";
  if (!collection) L.fail(400, "INVALID", "kind must be run or action");
  let out = null;
  $app.runInTransaction(function (tx) {
    const r = L.getOne(collection, id, tx);
    if (!r) L.fail(404, "NOT_FOUND", kind + " not found");
    if (r.status !== to) assertTransition(kind === "run" ? RUN_TRANSITIONS : ACTION_TRANSITIONS, r.status, to, kind);
    if (body.expectFrom && r.status !== body.expectFrom && r.status !== to) L.fail(409, "STALE", kind + " is " + r.status + ", expected " + body.expectFrom);
    const data = Object.assign({}, patch, { status: to, updated_at: L.now() });
    delete data.organization; delete data.client; delete data.website;
    out = L.updateRec(collection, id, data, tx);
  });
  return out;
}

// Acting user for delegated execution: the admin who last changed the policy.
// Re-validated on every call (still active, same organization, writer role).
function actingActor(policy) {
  const L = lib();
  const uid = String(policy.updated_by || policy.created_by || "");
  let u = null;
  try { u = $app.findRecordById("users", uid); } catch (_) { u = null; }
  if (!u) L.fail(409, "NO_ACTING_USER", "The admin who configured Autopilot no longer exists. An admin must save the policy again.");
  const actor = { id: u.id, organization: u.getString("organization"), role: u.getString("role"), status: u.getString("status"), name: u.getString("name"), email: u.email(), via: "autopilot" };
  if (actor.organization !== policy.organization) L.fail(409, "NO_ACTING_USER", "Acting user left the organization.");
  if (actor.status && actor.status !== "active") L.fail(409, "NO_ACTING_USER", "Acting user is disabled.");
  if (actor.role === "viewer" || actor.role === "client") L.fail(409, "NO_ACTING_USER", "Acting user can no longer manage content.");
  return actor;
}

const PAGE_TYPE_TO_CONTENT = { blog_post: "blog_article", blog_article: "blog_article", article: "blog_article", service_page: "service_page", service: "service_page", location_page: "location_page", location: "location_page", guide: "guide", pillar_page: "guide", comparison: "comparison", faq: "faq_page", faq_page: "faq_page" };

// JS port of src/lib/content/core.ts inferContentType/prepareGeneration defaults
// (the same inputs a human gets pre-filled in the Generate form).
function generationDefaults(opportunity, website, client) {
  const L = lib();
  const action = String(opportunity.opportunity_type || "").toLowerCase();
  let type;
  if (opportunity.existing_page && ["optimize", "expand", "refresh", "merge"].indexOf(action) !== -1) type = "existing_page_optimization";
  else if (action === "location") type = "location_page";
  else if (action === "service") type = "service_page";
  else type = PAGE_TYPE_TO_CONTENT[String(opportunity.recommended_page_type || "").toLowerCase()] || "blog_article";
  const keyword = opportunity.keyword ? L.getOne("keywords", opportunity.keyword) : null;
  const page = opportunity.existing_page ? L.getOne("website_pages", opportunity.existing_page) : null;
  const location = type === "location_page" ? String((keyword && keyword.target_location) || client.primary_location || "") : "";
  return {
    content_type: type,
    primary_keyword: L.clean((keyword && keyword.keyword) || opportunity.title_suggestion, 200),
    target_location: L.clean(location, 200),
    recommended_url: L.clean(opportunity.recommended_url || (page && page.url) || "", 500),
    reason: L.clean(String(opportunity.reason || "").replace(/<[^>]+>/g, " "), 1500),
    language: L.clean(website.primary_language || client.primary_language || "es", 10).toLowerCase() || "es",
    pause_after_brief: false,
  };
}

function internalExecute(body) {
  const L = lib();
  const P = require(`${__hooks}/bsa_publish.js`);
  const action = L.getOne("autopilot_actions", String(body.actionId || ""));
  if (!action) L.fail(404, "NOT_FOUND", "action not found");
  const policy = policyOf(action.website);
  if (!policy) L.fail(409, "POLICY", "No policy");
  const website = L.getOne("websites", action.website);
  if (!website || website.organization !== action.organization || website.client !== action.client) L.fail(409, "TENANT_MISMATCH", "Action tenant mismatch");
  const snap = action.policy_snapshot || {};
  // Live re-check at execution time: kill switch, website pause, OFF, mode.
  if (orgPaused(action.organization)) L.fail(409, "AUTOPILOT_PAUSED", "Organization kill switch is on.");
  if (policy.paused) L.fail(409, "AUTOPILOT_PAUSED", "Autopilot is paused for this website.");
  if (!policy.enabled || policy.mode !== "SUPERVISED") L.fail(409, "POLICY", "Autopilot is not SUPERVISED.");
  if ((snap.allowed_actions || []).indexOf(action.action_type) === -1) L.fail(409, "POLICY", action.action_type + " is not allowed by the policy snapshot.");
  const actor = actingActor(policy);
  const type = action.action_type;
  const target = String(action.target_id || "");
  if (type === "CRAWL") {
    const active = L.findFirst("crawl_jobs", "website = {:w} && (status = 'queued' || status = 'running')", "", { w: website.id });
    if (active) return { job_type: "crawl_job", job_id: active.id, created: false };
    const job = L.createRec("crawl_jobs", { organization: website.organization, client: website.client, website: website.id, status: "queued", triggered_by: actor.id, configuration: { source: "autopilot", action: action.id }, created_at: L.now() });
    L.logActivity($app, { organization: website.organization, client: website.client, website: website.id, user: actor.id, action: "WEBSITE_ANALYSIS_STARTED", entity_type: "crawl_job", entity_id: job.id, metadata: { via: "autopilot", autopilot_action: action.id } });
    return { job_type: "crawl_job", job_id: job.id, created: true };
  }
  if (type === "STRATEGY_REFRESH") {
    const active = L.findFirst("strategy_jobs", "website = {:w} && (status = 'queued' || status = 'running')", "", { w: website.id });
    if (active) return { job_type: "strategy_job", job_id: active.id, created: false };
    const job = L.createRec("strategy_jobs", { organization: website.organization, client: website.client, website: website.id, status: "queued", step: "queued", progress: 0, triggered_by: actor.id, configuration: { source: "autopilot", action: action.id }, created_at: L.now(), updated_at: L.now() });
    L.logActivity($app, { organization: website.organization, client: website.client, website: website.id, user: actor.id, action: "STRATEGY_GENERATION_STARTED", entity_type: "strategy_job", entity_id: job.id, metadata: { via: "autopilot", autopilot_action: action.id } });
    return { job_type: "strategy_job", job_id: job.id, created: true };
  }
  if (type === "GENERATE_CONTENT") {
    const opp = L.getOne("content_opportunities", target);
    if (!opp || opp.website !== website.id) L.fail(404, "NOT_FOUND", "Opportunity not found for this website.");
    if (opp.status === "proposed") {
      // Topic auto-selection (simple mode). Only topic choice is delegated; the
      // article itself still goes through Fact Check, QA and HUMAN approval.
      if (!policy.auto_pick_opportunities) L.fail(409, "NOT_APPROVED", "Opportunity is not approved and auto topic selection is off.");
      L.updateRec("content_opportunities", opp.id, { status: "approved", overridden_by: actor.id, overridden_at: L.now(), override_reason: "Auto-selected by Autopilot daily posts (policy v" + policy.version + ")" });
      L.logActivity($app, { organization: website.organization, client: website.client, website: website.id, user: actor.id, action: "OPPORTUNITY_AUTO_SELECTED", entity_type: "content_opportunity", entity_id: opp.id, metadata: { via: "autopilot", autopilot_action: action.id, policy_version: policy.version } });
      opp.status = "approved";
    }
    const client = L.getOne("clients", website.client);
    const inputs = generationDefaults(opp, website, client);
    // Phase 4 entry point: approval-state, duplicate generation_key, rate
    // limits and tenant checks are enforced by startGeneration itself.
    const r = L.startGeneration(actor, { websiteId: website.id, source: { kind: "opportunity", id: opp.id }, inputs: inputs });
    return { job_type: "content_job", job_id: r.job ? r.job.id : "", article_id: r.article.id, article_status: r.article.status, created: r.created, inputs: inputs };
  }
  if (type === "REQUEST_REVISION") {
    const a = L.getOne("articles", target);
    if (!a || a.website !== website.id) L.fail(404, "NOT_FOUND", "Article not found.");
    const instruction = L.clean(body.instruction, 2000);
    if (instruction) {
      const j = L.requestRevision(actor, { articleId: a.id, instruction: instruction });
      return { job_type: "content_job", job_id: j.id, article_id: a.id, mode: "revision" };
    }
    const j = L.retryGeneration(actor, { articleId: a.id });
    return { job_type: "content_job", job_id: j.id, article_id: a.id, mode: j.mode };
  }
  if (type === "RECHECK_CONTENT") {
    const j = L.requestRecheck(actor, { articleId: target });
    return { job_type: "content_job", job_id: j.id, article_id: target, mode: "recheck" };
  }
  if (type === "PUBLISH" || type === "UPDATE_PUBLICATION") {
    const a = L.getOne("articles", target);
    if (!a || a.website !== website.id) L.fail(404, "NOT_FOUND", "Article not found.");
    // Never publishes without a recorded HUMAN approval. approved_by must be a
    // users record of this organization and must differ from nothing forged by Autopilot.
    if (!a.approved_by || !a.approved_at) L.fail(409, "NOT_APPROVED", "No human approval recorded.");
    let approver = null;
    try { approver = $app.findRecordById("users", a.approved_by); } catch (_) { approver = null; }
    if (!approver || approver.getString("organization") !== a.organization) L.fail(409, "NOT_APPROVED", "Approval is not from a member of this organization.");
    if (a.high_risk) L.fail(409, "HIGH_RISK_REVIEW_REQUIRED", "High-risk content always waits for a manual Publish.");
    if (!snap.publish_after_human_approval || !policy.publish_after_human_approval) L.fail(409, "POLICY", "publish_after_human_approval is off.");
    if ((snap.allowed_environments || []).indexOf(website.publishing_environment) === -1 || (policy.allowed_environments || []).indexOf(website.publishing_environment) === -1) L.fail(409, "ENVIRONMENT_NOT_ALLOWED", "Publishing environment " + website.publishing_environment + " is not allowed by the Autopilot policy.");
    if (body.expectedHash && body.expectedHash !== a.approved_hash) L.fail(409, "APPROVAL_CHANGED", "The approved version changed; waiting for the new approval.");
    const pv = P.preview(actor, { articleId: a.id });
    if (pv.blockers && pv.blockers.length) L.fail(409, pv.slug_conflict ? "SLUG_CONFLICT" : "NOT_PUBLISHABLE", pv.blockers.join(" "));
    // Phase 5 entry point: approval lock, hash, idempotency, slug conflicts.
    const r = P.requestPublish(actor, { articleId: a.id, confirm: true, operation: pv.operation });
    return { job_type: "publish_job", job_id: r.id, operation: r.operation, created: r.created, approved_version: a.approved_version, approved_hash: a.approved_hash, approved_by: a.approved_by, environment: website.publishing_environment };
  }
  if (type === "AUTO_PUBLISH") {
    // Simple mode. The approval is recorded under the admin who switched on
    // auto-publish (the acting user) and is marked as a policy approval.
    if (!policy.auto_publish_safe || !snap.auto_publish_safe) L.fail(409, "POLICY", "Safe auto-publish is off.");
    const a = L.getOne("articles", target);
    if (!a || a.website !== website.id) L.fail(404, "NOT_FOUND", "Article not found.");
    const managed = L.findFirst("autopilot_actions", "website = {:w} && article = {:a} && action_type = 'GENERATE_CONTENT'", "", { w: website.id, a: a.id });
    if (!managed) L.fail(409, "NOT_MANAGED", "Only posts written by Autopilot can be auto-published.");
    const why = autoPublishBlockers(a);
    if (why.length) L.fail(409, "NOT_SAFE", "Not safe to auto-publish: " + why.join("; "));
    if ((policy.allowed_environments || []).indexOf(website.publishing_environment) === -1) L.fail(409, "ENVIRONMENT_NOT_ALLOWED", "Publishing environment " + website.publishing_environment + " is not allowed.");
    const approved = L.approveArticle(actor, { articleId: a.id });
    const prov = Object.assign({}, approved.provenance || a.provenance || {}, { auto_published_by_policy: true, auto_publish_policy_version: policy.version, auto_publish_action: action.id });
    L.updateRec("articles", a.id, { provenance: prov });
    L.logActivity($app, { organization: website.organization, client: website.client, website: website.id, user: actor.id, action: "ARTICLE_AUTO_APPROVED", entity_type: "article", entity_id: a.id, metadata: { via: "autopilot", rule: "auto_publish_safe", policy_version: policy.version, autopilot_action: action.id } });
    const pv = P.preview(actor, { articleId: a.id });
    if (pv.blockers && pv.blockers.length) L.fail(409, pv.slug_conflict ? "SLUG_CONFLICT" : "NOT_PUBLISHABLE", pv.blockers.join(" "));
    const r = P.requestPublish(actor, { articleId: a.id, confirm: true, operation: pv.operation });
    return { job_type: "publish_job", job_id: r.id, operation: r.operation, created: r.created, auto: true, environment: website.publishing_environment };
  }
  if (type === "VERIFY_PUBLICATION") {
    const r = P.requestVerify(actor, { articleId: target });
    return { job_type: "publish_job", job_id: r.id, operation: "verify", created: r.created };
  }
  L.fail(400, "UNSUPPORTED", "Action type " + type + " is not executable.");
}

// Read-only preview for the decision engine (blockers of a would-be publish).
function internalPublishPreview(body) {
  const L = lib();
  const P = require(`${__hooks}/bsa_publish.js`);
  const a = L.getOne("articles", String(body.articleId || ""));
  if (!a) L.fail(404, "NOT_FOUND", "article not found");
  const policy = policyOf(a.website);
  if (!policy) L.fail(409, "POLICY", "No policy");
  const actor = actingActor(policy);
  return P.preview(actor, { articleId: a.id });
}

// ---------------------------------------------------------------- event triggers (record hooks)

function enqueueTrigger(record, trigger, entityType, dedupKey, payload) {
  const L = lib();
  try {
    const websiteId = record.getString("website");
    if (!websiteId) return;
    const p = policyOf(websiteId);
    if (!p || !p.enabled || p.mode === "OFF") return;
    const existing = L.findFirst("autopilot_triggers", "dedup_key = {:k}", "", { k: dedupKey });
    if (existing) return; // same event twice → one logical trigger
    L.createRec("autopilot_triggers", {
      organization: record.getString("organization"), client: p.client, website: websiteId, trigger: trigger, entity_type: entityType, entity_id: record.id,
      payload: payload || {}, dedup_key: dedupKey, status: "pending", created_at: L.now(), updated_at: L.now(),
    });
  } catch (err) {
    $app.logger().error("autopilot trigger enqueue failed", "trigger", trigger, "error", String(err));
  }
}

function ensureDefaultPolicyForWebsite(record) {
  const L = lib();
  try {
    if (policyOf(record.id)) return;
    const ts = L.now();
    L.createRec("autopilot_policies", Object.assign({}, DEFAULT_POLICY, { organization: record.getString("organization"), client: record.getString("client"), website: record.id, version: 1, created_at: ts, updated_at: ts }));
  } catch (err) {
    $app.logger().error("autopilot default policy failed", "website", record.id, "error", String(err));
  }
}

module.exports = {
  ensureDefaultPolicyForWebsite,
  MODES, ACTION_TYPES, DEFAULT_POLICY, HOT_RUN, PARKED_RUN, TERMINAL_RUN, RUN_TRANSITIONS, ACTION_TRANSITIONS,
  getPolicy, previewPolicy, savePolicy, setWebsitePause, setOrgPause, requestRun, decideSignal, cancelAction, resolveTask, resetCircuit,
  internalLease, internalTransition, internalExecute, internalPublishPreview, enqueueTrigger, consequences, publicPolicy, generationDefaults,
};
