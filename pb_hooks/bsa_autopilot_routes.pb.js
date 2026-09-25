// Phase 7 — Autopilot endpoints and event triggers.
// User routes run as the signed-in user (tenant + role derived server-side).
// /api/bsa/internal/autopilot/* is for the bunker-seo-autopilot worker only.

routerAdd("POST", "/api/bsa/autopilot/policy", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const ap = require(`${__hooks}/bsa_autopilot.js`);
  return lib.handle(e, (actor, body) => ap.getPolicy(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/autopilot/policy/preview", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const ap = require(`${__hooks}/bsa_autopilot.js`);
  return lib.handle(e, (actor, body) => ap.previewPolicy(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/autopilot/policy/save", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const ap = require(`${__hooks}/bsa_autopilot.js`);
  return lib.handle(e, (actor, body) => ap.savePolicy(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/autopilot/enable", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const ap = require(`${__hooks}/bsa_autopilot.js`);
  return lib.handle(e, (actor, body) => ap.savePolicy(actor, Object.assign({}, body, { enabled: true })));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/autopilot/disable", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const ap = require(`${__hooks}/bsa_autopilot.js`);
  return lib.handle(e, (actor, body) => ap.savePolicy(actor, { websiteId: body.websiteId, enabled: false }));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/autopilot/pause", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const ap = require(`${__hooks}/bsa_autopilot.js`);
  return lib.handle(e, (actor, body) => ap.setWebsitePause(actor, body, true));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/autopilot/resume", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const ap = require(`${__hooks}/bsa_autopilot.js`);
  return lib.handle(e, (actor, body) => ap.setWebsitePause(actor, body, false));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/autopilot/org/pause", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const ap = require(`${__hooks}/bsa_autopilot.js`);
  return lib.handle(e, (actor, body) => ap.setOrgPause(actor, body, true));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/autopilot/org/resume", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const ap = require(`${__hooks}/bsa_autopilot.js`);
  return lib.handle(e, (actor, body) => ap.setOrgPause(actor, body, false));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/autopilot/run", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const ap = require(`${__hooks}/bsa_autopilot.js`);
  return lib.handle(e, (actor, body) => ap.requestRun(actor, body, false));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/autopilot/dry-run", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const ap = require(`${__hooks}/bsa_autopilot.js`);
  return lib.handle(e, (actor, body) => ap.requestRun(actor, body, true));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/autopilot/signal", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const ap = require(`${__hooks}/bsa_autopilot.js`);
  return lib.handle(e, (actor, body) => ap.decideSignal(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/autopilot/action/cancel", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const ap = require(`${__hooks}/bsa_autopilot.js`);
  return lib.handle(e, (actor, body) => ap.cancelAction(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/autopilot/task", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const ap = require(`${__hooks}/bsa_autopilot.js`);
  return lib.handle(e, (actor, body) => ap.resolveTask(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/autopilot/circuit/reset", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const ap = require(`${__hooks}/bsa_autopilot.js`);
  return lib.handle(e, (actor, body) => ap.resetCircuit(actor, body));
}, $apis.requireAuth("users"));

// ---------------------------------------------------------------- internal (worker)
routerAdd("POST", "/api/bsa/internal/autopilot/lease", (e) => {
  const ap = require(`${__hooks}/bsa_autopilot.js`);
  try { return e.json(200, { result: ap.internalLease(e.requestInfo().body || {}) }); } catch (err) {
    if (err && err.bsa) return e.json(err.bsa.status, { code: err.bsa.code, message: err.bsa.message });
    $app.logger().error("bsa internal autopilot failed", "path", e.request.url.path, "error", String(err));
    return e.json(500, { code: "INTERNAL", message: "internal error" });
  }
}, $apis.requireSuperuserAuth());

routerAdd("POST", "/api/bsa/internal/autopilot/transition", (e) => {
  const ap = require(`${__hooks}/bsa_autopilot.js`);
  try { return e.json(200, { result: ap.internalTransition(e.requestInfo().body || {}) }); } catch (err) {
    if (err && err.bsa) return e.json(err.bsa.status, { code: err.bsa.code, message: err.bsa.message });
    $app.logger().error("bsa internal autopilot failed", "path", e.request.url.path, "error", String(err));
    return e.json(500, { code: "INTERNAL", message: "internal error" });
  }
}, $apis.requireSuperuserAuth());

routerAdd("POST", "/api/bsa/internal/autopilot/execute", (e) => {
  const ap = require(`${__hooks}/bsa_autopilot.js`);
  try { return e.json(200, { result: ap.internalExecute(e.requestInfo().body || {}) }); } catch (err) {
    if (err && err.bsa) return e.json(err.bsa.status, { code: err.bsa.code, message: err.bsa.message });
    $app.logger().error("bsa internal autopilot failed", "path", e.request.url.path, "error", String(err));
    return e.json(500, { code: "INTERNAL", message: "internal error" });
  }
}, $apis.requireSuperuserAuth());

routerAdd("POST", "/api/bsa/internal/autopilot/publish-preview", (e) => {
  const ap = require(`${__hooks}/bsa_autopilot.js`);
  try { return e.json(200, { result: ap.internalPublishPreview(e.requestInfo().body || {}) }); } catch (err) {
    if (err && err.bsa) return e.json(err.bsa.status, { code: err.bsa.code, message: err.bsa.message });
    $app.logger().error("bsa internal autopilot failed", "path", e.request.url.path, "error", String(err));
    return e.json(500, { code: "INTERNAL", message: "internal error" });
  }
}, $apis.requireSuperuserAuth());

// ---------------------------------------------------------------- event triggers
// Record hooks only ENQUEUE a trigger row when the website has Autopilot
// enabled; the worker consumes them (no long-lived waiting process).
onRecordAfterUpdateSuccess((e) => {
  const before = e.record.original().getString("status");
  const after = e.record.getString("status");
  if (before !== after) {
    const ap = require(`${__hooks}/bsa_autopilot.js`);
    const id = e.record.id;
    if (after === "approved") ap.enqueueTrigger(e.record, "article_approved", "article", "article_approved:" + id + ":" + e.record.getString("approved_hash"), { version: e.record.getInt("approved_version") });
    else if (after === "awaiting_approval") ap.enqueueTrigger(e.record, "article_ready", "article", "article_ready:" + id + ":v" + e.record.getInt("current_version"), {});
    else if (after === "rejected") ap.enqueueTrigger(e.record, "article_rejected", "article", "article_rejected:" + id, {});
    else if (after === "published") ap.enqueueTrigger(e.record, "publication_completed", "article", "article_published:" + id + ":" + e.record.getString("approved_hash"), {});
    else if (after === "publish_failed") ap.enqueueTrigger(e.record, "publication_failed", "article", "article_publish_failed:" + id + ":" + e.record.getString("updated_at"), {});
    else if (after === "needs_revision" || after === "failed") ap.enqueueTrigger(e.record, "content_job_finished", "article", "article_" + after + ":" + id + ":v" + e.record.getInt("current_version") + ":" + e.record.getString("updated_at"), {});
  }
  e.next();
}, "articles");

onRecordAfterUpdateSuccess((e) => {
  const before = e.record.original().getString("status");
  const after = e.record.getString("status");
  if (before !== after && (after === "completed" || after === "failed") && e.record.getString("mode") === "recheck") {
    const ap = require(`${__hooks}/bsa_autopilot.js`);
    ap.enqueueTrigger(e.record, "content_recheck_completed", "content_job", "content_recheck:" + e.record.id, { article: e.record.getString("article") });
  }
  e.next();
}, "content_jobs");

onRecordAfterUpdateSuccess((e) => {
  const before = e.record.original().getString("status");
  const after = e.record.getString("status");
  if (before !== after && (after === "completed" || after === "completed_with_errors")) {
    const ap = require(`${__hooks}/bsa_autopilot.js`);
    ap.enqueueTrigger(e.record, "crawl_completed", "crawl_job", "crawl_completed:" + e.record.id, {});
  }
  e.next();
}, "crawl_jobs");

onRecordAfterUpdateSuccess((e) => {
  const before = e.record.original().getString("status");
  const after = e.record.getString("status");
  if (before !== after && (after === "completed" || after === "completed_with_errors")) {
    const ap = require(`${__hooks}/bsa_autopilot.js`);
    ap.enqueueTrigger(e.record, "strategy_completed", "strategy_job", "strategy_completed:" + e.record.id, {});
  }
  e.next();
}, "strategy_jobs");

onRecordAfterUpdateSuccess((e) => {
  const before = e.record.original().getString("status");
  const after = e.record.getString("status");
  if (before !== after && (after === "completed" || after === "completed_with_warnings")) {
    const ap = require(`${__hooks}/bsa_autopilot.js`);
    ap.enqueueTrigger(e.record, "gsc_sync_completed", "gsc_sync_job", "gsc_sync_completed:" + e.record.id, {});
  }
  e.next();
}, "gsc_sync_jobs");

onRecordAfterCreateSuccess((e) => {
  const ap = require(`${__hooks}/bsa_autopilot.js`);
  ap.enqueueTrigger(e.record, "analytics_opportunity_created", "analytics_opportunity", "analytics_opp:" + e.record.id, { type: e.record.getString("type") });
  e.next();
}, "analytics_opportunities");

onRecordAfterUpdateSuccess((e) => {
  const before = e.record.original().getString("status");
  const after = e.record.getString("status");
  if (before !== after && ["published", "verification_required", "failed", "unpublished"].indexOf(after) !== -1 && e.record.getString("article")) {
    const ap = require(`${__hooks}/bsa_autopilot.js`);
    ap.enqueueTrigger(e.record, after === "failed" ? "publication_failed" : "publication_completed", "publish_job", "publish_job:" + e.record.id + ":" + after, { operation: e.record.getString("operation"), article: e.record.getString("article") });
  }
  e.next();
}, "publish_jobs");

// Every new website gets a safe default policy (OFF, disabled).
onRecordAfterCreateSuccess((e) => {
  const ap = require(`${__hooks}/bsa_autopilot.js`);
  ap.ensureDefaultPolicyForWebsite(e.record);
  e.next();
}, "websites");
