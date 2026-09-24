// Server-side activity logging for user-initiated REST mutations and account
// safety rules. Runs inside PocketBase, so the Next.js app needs no superuser
// credentials and users cannot forge log rows (activity_logs.createRule = null).
// Only requests made with a *users* token are logged here; the workers and
// admin maintenance (superuser) do not generate user activity.

// ---------------------------------------------------------------- login
onRecordAuthWithPasswordRequest((e) => {
  e.next();
  const lib = require(`${__hooks}/bsa_lib.js`);
  const user = e.record;
  if (!user) return;
  lib.safeLog({ organization: user.getString("organization"), user: user.id, action: "USER_LOGIN", entity_type: "user", entity_id: user.id, metadata: { method: "password" } });
}, "users");

// ---------------------------------------------------------------- users: privilege escalation guard
// Users may edit their own profile (name, password, avatar) but never their
// own organization, role or status. Only an org admin may change another
// member's role/status, only inside their org, and never to super_admin.
onRecordUpdateRequest((e) => {
  const auth = e.auth;
  if (auth && !auth.isSuperuser()) {
    const before = e.record.original();
    const changed = (f) => String(before.get(f) ?? "") !== String(e.record.get(f) ?? "");
    const isSelf = auth.id === e.record.id;
    const isOrgAdmin = auth.getString("role") === "admin" || auth.getString("role") === "super_admin";
    if (changed("organization")) throw new ForbiddenError("The organization of an account cannot be changed.");
    if (isSelf && (changed("role") || changed("status"))) throw new ForbiddenError("You cannot change your own role or status.");
    if (!isSelf && !isOrgAdmin) throw new ForbiddenError("Only organization admins can manage members.");
    if (changed("role") && e.record.getString("role") === "super_admin" && auth.getString("role") !== "super_admin") throw new ForbiddenError("super_admin cannot be granted from the app.");
  }
  e.next();
}, "users");

onRecordCreateRequest((e) => {
  const auth = e.auth;
  if (auth && !auth.isSuperuser()) {
    if (e.record.getString("organization") !== auth.getString("organization")) throw new ForbiddenError("Members can only be invited into your organization.");
    if (e.record.getString("role") === "super_admin" && auth.getString("role") !== "super_admin") throw new ForbiddenError("super_admin cannot be granted from the app.");
  }
  e.next();
  if (auth && !auth.isSuperuser()) {
    const lib = require(`${__hooks}/bsa_lib.js`);
    lib.safeLog({ organization: auth.getString("organization"), user: auth.id, action: "USER_INVITED", entity_type: "user", entity_id: e.record.id, metadata: { role: e.record.getString("role") } });
  }
}, "users");

// ---------------------------------------------------------------- clients
onRecordCreateRequest((e) => {
  e.next();
  const lib = require(`${__hooks}/bsa_lib.js`);
  const user = lib.requestUser(e);
  if (!user) return;
  lib.safeLog({ organization: e.record.getString("organization"), user: user.id, client: e.record.id, action: "CLIENT_CREATED", entity_type: "client", entity_id: e.record.id, metadata: { business_name: e.record.getString("business_name") } });
}, "clients");

onRecordUpdateRequest((e) => {
  const wasStatus = e.record.original().getString("status");
  e.next();
  const lib = require(`${__hooks}/bsa_lib.js`);
  const user = lib.requestUser(e);
  if (!user) return;
  const archived = e.record.getString("status") === "archived" && wasStatus !== "archived";
  lib.safeLog({ organization: e.record.getString("organization"), user: user.id, client: e.record.id, action: archived ? "CLIENT_ARCHIVED" : "CLIENT_UPDATED", entity_type: "client", entity_id: e.record.id, metadata: { business_name: e.record.getString("business_name") } });
}, "clients");

// ---------------------------------------------------------------- websites
onRecordCreateRequest((e) => {
  e.next();
  const lib = require(`${__hooks}/bsa_lib.js`);
  const user = lib.requestUser(e);
  if (!user) return;
  lib.safeLog({ organization: e.record.getString("organization"), user: user.id, client: e.record.getString("client"), website: e.record.id, action: "WEBSITE_CREATED", entity_type: "website", entity_id: e.record.id, metadata: { domain: e.record.getString("domain") } });
}, "websites");

onRecordUpdateRequest((e) => {
  const wasStatus = e.record.original().getString("status");
  e.next();
  const lib = require(`${__hooks}/bsa_lib.js`);
  const user = lib.requestUser(e);
  if (!user) return;
  const archived = e.record.getString("status") === "archived" && wasStatus !== "archived";
  lib.safeLog({ organization: e.record.getString("organization"), user: user.id, client: e.record.getString("client"), website: e.record.id, action: archived ? "WEBSITE_ARCHIVED" : "WEBSITE_UPDATED", entity_type: "website", entity_id: e.record.id, metadata: { domain: e.record.getString("domain") } });
}, "websites");

// ---------------------------------------------------------------- jobs
onRecordCreateRequest((e) => {
  e.next();
  const lib = require(`${__hooks}/bsa_lib.js`);
  const user = lib.requestUser(e);
  if (!user) return;
  lib.safeLog({ organization: e.record.getString("organization"), user: user.id, client: e.record.getString("client"), website: e.record.getString("website"), action: "WEBSITE_ANALYSIS_STARTED", entity_type: "crawl_job", entity_id: e.record.id, metadata: {} });
}, "crawl_jobs");

onRecordCreateRequest((e) => {
  e.next();
  const lib = require(`${__hooks}/bsa_lib.js`);
  const user = lib.requestUser(e);
  if (!user) return;
  lib.safeLog({ organization: e.record.getString("organization"), user: user.id, client: e.record.getString("client"), website: e.record.getString("website"), action: "STRATEGY_GENERATION_STARTED", entity_type: "strategy_job", entity_id: e.record.id, metadata: {} });
}, "strategy_jobs");

// Worker-driven completion (any writer, incl. the intelligence worker).
onRecordAfterUpdateSuccess((e) => {
  const before = e.record.original().getString("status");
  const after = e.record.getString("status");
  if (before !== after && (after === "completed" || after === "completed_with_errors")) {
    const lib = require(`${__hooks}/bsa_lib.js`);
    lib.safeLog({ organization: e.record.getString("organization"), user: e.record.getString("triggered_by"), client: e.record.getString("client"), website: e.record.getString("website"), action: "STRATEGY_GENERATED", entity_type: "strategy_job", entity_id: e.record.id, metadata: { status: after } });
  }
  e.next();
}, "strategy_jobs");

onRecordAfterUpdateSuccess((e) => {
  const before = e.record.original().getString("status");
  const after = e.record.getString("status");
  if (before !== after && after === "awaiting_approval") {
    const lib = require(`${__hooks}/bsa_lib.js`);
    lib.safeLog({ organization: e.record.getString("organization"), client: e.record.getString("client"), website: e.record.getString("website"), action: "ARTICLE_READY_FOR_REVIEW", entity_type: "article", entity_id: e.record.id, metadata: { qa_status: e.record.getString("qa_status") } });
  }
  e.next();
}, "articles");
