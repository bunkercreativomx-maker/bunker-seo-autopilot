// Authenticated user endpoints for Bunker SEO Autopilot. Every route requires
// a *users* token (superuser tokens are rejected by actorOf) and derives the
// tenant from the database record behind that token. See bsa_lib.js.

routerAdd("POST", "/api/bsa/content/generate", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  return lib.handle(e, (actor, body) => {
    const r = lib.startGeneration(actor, body);
    return { article: { id: r.article.id, status: r.article.status }, job: r.job ? { id: r.job.id, status: r.job.status, mode: r.job.mode } : null, created: r.created };
  });
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/content/edit", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  return lib.handle(e, (actor, body) => lib.saveManualEdit(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/content/restore", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  return lib.handle(e, (actor, body) => lib.restoreVersion(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/content/approve", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  return lib.handle(e, (actor, body) => { const a = lib.approveArticle(actor, body); return { id: a.id, status: a.status, approved_by: a.approved_by, approved_at: a.approved_at }; });
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/content/reject", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  return lib.handle(e, (actor, body) => { const a = lib.rejectArticle(actor, body); return { id: a.id, status: a.status }; });
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/content/revision", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  return lib.handle(e, (actor, body) => { const j = lib.requestRevision(actor, body); return { id: j.id, mode: j.mode, status: j.status, revision_instruction: j.revision_instruction }; });
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/content/retry", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  return lib.handle(e, (actor, body) => { const j = lib.retryGeneration(actor, body); return { id: j.id, mode: j.mode, status: j.status, attempt: j.attempt }; });
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/content/recheck", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  return lib.handle(e, (actor, body) => { const j = lib.requestRecheck(actor, body); return { id: j.id, mode: j.mode, status: j.status }; });
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/content/continue", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  return lib.handle(e, (actor, body) => { const j = lib.continueAfterBrief(actor, body); return { id: j.id, mode: j.mode, status: j.status }; });
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/content/brief", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  return lib.handle(e, (actor, body) => lib.saveBrief(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/content/cancel", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  return lib.handle(e, (actor, body) => lib.cancelJob(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/strategy/record", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  return lib.handle(e, (actor, body) => lib.updateStrategyRecord(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/organization", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  return lib.handle(e, (actor, body) => lib.updateOrganization(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/logout", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  try {
    return e.json(200, lib.logout(e));
  } catch (err) {
    if (err && err.bsa) return e.json(err.bsa.status, { code: err.bsa.code, message: err.bsa.message });
    $app.logger().error("bsa logout failed", "error", String(err));
    return e.json(500, { code: "INTERNAL", message: "Logout failed." });
  }
}, $apis.requireAuth("users"));


// ---------------------------------------------------------------- Phase 5: publishing
// Queue-only endpoints: nothing here contacts a website. The independent
// bunker-seo-publisher worker performs every outbound request.
routerAdd("POST", "/api/bsa/publishing/config", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const pub = require(`${__hooks}/bsa_publish.js`);
  return lib.handle(e, (actor, body) => pub.saveConfig(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/publishing/secret", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const pub = require(`${__hooks}/bsa_publish.js`);
  return lib.handle(e, (actor, body) => pub.saveSecret(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/publishing/test", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const pub = require(`${__hooks}/bsa_publish.js`);
  return lib.handle(e, (actor, body) => pub.testConnection(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/publishing/preview", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const pub = require(`${__hooks}/bsa_publish.js`);
  return lib.handle(e, (actor, body) => pub.preview(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/publishing/publish", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const pub = require(`${__hooks}/bsa_publish.js`);
  return lib.handle(e, (actor, body) => pub.requestPublish(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/publishing/unpublish", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const pub = require(`${__hooks}/bsa_publish.js`);
  return lib.handle(e, (actor, body) => pub.requestUnpublish(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/publishing/verify", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const pub = require(`${__hooks}/bsa_publish.js`);
  return lib.handle(e, (actor, body) => pub.requestVerify(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/publishing/rollback", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const pub = require(`${__hooks}/bsa_publish.js`);
  return lib.handle(e, (actor, body) => pub.requestRollback(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/publishing/cancel", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const pub = require(`${__hooks}/bsa_publish.js`);
  return lib.handle(e, (actor, body) => pub.cancelJob(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/publishing/versions", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const pub = require(`${__hooks}/bsa_publish.js`);
  return lib.handle(e, (actor, body) => {
    const a = lib.getOne("articles", String(body.articleId || ""));
    if (!a || a.organization !== actor.organization) lib.fail(404, "NOT_FOUND", "Article not found.");
    return { versions: pub.publishedVersions(a.id) };
  });
}, $apis.requireAuth("users"));
