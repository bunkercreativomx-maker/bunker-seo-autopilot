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
// One-click connect (Vercel rewrite to the Bunker Rank blog hub).
routerAdd("POST", "/api/bsa/connect/info", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const c = require(`${__hooks}/bsa_connect.js`);
  return lib.handle(e, (actor, body) => c.info(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/connect/verify", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const c = require(`${__hooks}/bsa_connect.js`);
  return lib.handle(e, (actor, body) => c.verify(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/connect/disconnect", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const c = require(`${__hooks}/bsa_connect.js`);
  return lib.handle(e, (actor, body) => c.disconnect(actor, body));
}, $apis.requireAuth("users"));

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

// ---------------------------------------------------------------- Phase 6: Search Console analytics
// Read-only Google integration. User endpoints run as the signed-in user
// (tenant + role checks inside bsa_gsc.js). /api/bsa/internal/gsc/* is for the
// bunker-seo-analytics worker only (PocketBase superuser).
routerAdd("POST", "/api/bsa/gsc/oauth/start", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  return lib.handle(e, (actor, body) => gsc.startOAuth(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/gsc/oauth/complete", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  return lib.handle(e, (actor, body) => gsc.completeOAuth(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/gsc/properties/refresh", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  return lib.handle(e, (actor, body) => gsc.refreshProperties(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/gsc/properties", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  return lib.handle(e, (actor, body) => gsc.listProperties(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/gsc/property/select", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  return lib.handle(e, (actor, body) => gsc.selectProperty(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/gsc/disconnect", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  return lib.handle(e, (actor, body) => gsc.disconnect(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/gsc/connection", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  return lib.handle(e, (actor, body) => gsc.connectionInfo(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/gsc/sync", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  return lib.handle(e, (actor, body) => gsc.requestSync(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/gsc/sync/cancel", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  return lib.handle(e, (actor, body) => gsc.cancelSync(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/analytics/summary", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  return lib.handle(e, (actor, body) => gsc.summary(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/analytics/queries", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  return lib.handle(e, (actor, body) => gsc.queries(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/analytics/pages", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  return lib.handle(e, (actor, body) => gsc.pages(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/analytics/query", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  return lib.handle(e, (actor, body) => gsc.queryDetail(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/analytics/article", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  return lib.handle(e, (actor, body) => gsc.articlePerformance(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/analytics/organization", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  return lib.handle(e, (actor, body) => gsc.orgOverview(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/analytics/client", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  return lib.handle(e, (actor, body) => gsc.clientOverview(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/analytics/opportunity/decide", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  return lib.handle(e, (actor, body) => gsc.decideOpportunity(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/analytics/brand", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  return lib.handle(e, (actor, body) => gsc.setBrandOverride(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/analytics/quality-flag", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  return lib.handle(e, (actor, body) => gsc.addQualityFlag(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/analytics/settings", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  return lib.handle(e, (actor, body) => gsc.saveSettings(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/notifications/read", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  return lib.handle(e, (actor, body) => gsc.markNotification(actor, body));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bsa/internal/gsc/upsert", (e) => {
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  try {
    return e.json(200, { result: gsc.internalUpsert(e.requestInfo().body || {}) });
  } catch (err) {
    if (err && err.bsa) return e.json(err.bsa.status, { code: err.bsa.code, message: err.bsa.message });
    $app.logger().error("bsa internal gsc failed", "path", e.request.url.path, "error", String(err));
    return e.json(500, { code: "INTERNAL", message: "internal error" });
  }
}, $apis.requireSuperuserAuth());

routerAdd("POST", "/api/bsa/internal/gsc/labels", (e) => {
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  try {
    return e.json(200, { result: gsc.internalLabels(e.requestInfo().body || {}) });
  } catch (err) {
    if (err && err.bsa) return e.json(err.bsa.status, { code: err.bsa.code, message: err.bsa.message });
    $app.logger().error("bsa internal gsc failed", "path", e.request.url.path, "error", String(err));
    return e.json(500, { code: "INTERNAL", message: "internal error" });
  }
}, $apis.requireSuperuserAuth());

routerAdd("POST", "/api/bsa/internal/gsc/aggregate", (e) => {
  const gsc = require(`${__hooks}/bsa_gsc.js`);
  try {
    return e.json(200, { result: gsc.internalAggregate(e.requestInfo().body || {}) });
  } catch (err) {
    if (err && err.bsa) return e.json(err.bsa.status, { code: err.bsa.code, message: err.bsa.message });
    $app.logger().error("bsa internal gsc failed", "path", e.request.url.path, "error", String(err));
    return e.json(500, { code: "INTERNAL", message: "internal error" });
  }
}, $apis.requireSuperuserAuth());

