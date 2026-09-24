// Bunker SEO Autopilot — trusted server-side operations that run INSIDE
// PocketBase (pb_hooks). The Next.js app calls these endpoints with the
// signed-in USER's token; it never holds superuser credentials.
//
// Security model
// - Authority comes from e.auth (the users record PocketBase loaded from the
//   verified token): organization, role and status are read from the database,
//   never from the request body. Client-supplied tenant ids are only lookup
//   keys and every record is re-checked against the actor's organization and
//   the website/client relationship before any write.
// - The collections touched here keep createRule/updateRule = null, so users
//   cannot bypass these checks with direct REST calls.
// - Activity logs are written here (and by record hooks), never by users.
// - Nothing in this file publishes content. "approved" is terminal in Phase 4.
//
// JSVM note: handlers run in isolated VMs, so every handler must
// require() this module itself.

const CONTENT_TYPES = ["blog_article", "service_page", "location_page", "guide", "comparison", "faq_page", "existing_page_optimization"];
const WRITER_BLOCKED_ROLES = ["viewer", "client"]; // content management
const EDITABLE = ["title", "slug", "seo_title", "meta_description", "excerpt", "content"];
const LIMITS = { title: 300, slug: 200, seo_title: 200, meta_description: 400, excerpt: 1000, content: 300000 };

function now() {
  return new Date().toISOString();
}

function clean(value, max) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

function fail(status, code, message) {
  const error = new Error(message);
  error.bsa = { status: status, code: code, message: message };
  throw error;
}

function toObj(record) {
  return record ? JSON.parse(JSON.stringify(record)) : null;
}

function isId(value) {
  return typeof value === "string" && /^[a-z0-9]{15}$/.test(value);
}

function getOne(collection, id, app) {
  if (!isId(id)) return null;
  try {
    return toObj((app || $app).findRecordById(collection, id));
  } catch (_) {
    return null;
  }
}

function findFirst(collection, filter, sort, params, app) {
  const rows = (app || $app).findRecordsByFilter(collection, filter, sort || "", 1, 0, params || {});
  return rows && rows.length && rows[0] ? toObj(rows[0]) : null;
}

function findMany(collection, filter, sort, limit, params, app) {
  const rows = (app || $app).findRecordsByFilter(collection, filter, sort || "", limit, 0, params || {});
  return (rows || []).filter(Boolean).map(toObj);
}

function createRec(collection, data, app) {
  const a = app || $app;
  const record = new Record(a.findCollectionByNameOrId(collection));
  for (const key of Object.keys(data)) record.set(key, data[key]);
  a.save(record);
  return toObj(record);
}

function updateRec(collection, id, data, app) {
  const a = app || $app;
  const record = a.findRecordById(collection, id);
  for (const key of Object.keys(data)) record.set(key, data[key]);
  a.save(record);
  return toObj(record);
}

// ---------------------------------------------------------------- identity

function actorOf(e) {
  const auth = e.auth;
  if (!auth || auth.isSuperuser() || auth.collection().name !== "users") fail(401, "UNAUTHENTICATED", "Sign in to continue.");
  const actor = {
    id: auth.id,
    organization: auth.getString("organization"),
    role: auth.getString("role"),
    status: auth.getString("status"),
    name: auth.getString("name"),
    email: auth.email(),
  };
  if (actor.status && actor.status !== "active") fail(403, "FORBIDDEN", "This account is disabled.");
  if (!actor.organization) fail(403, "FORBIDDEN", "Your account is not linked to an organization.");
  return actor;
}

function assertContentWriter(actor) {
  if (WRITER_BLOCKED_ROLES.indexOf(actor.role) !== -1) fail(403, "FORBIDDEN", "You do not have permission to manage content.");
}

// Phase 1–3 semantics: viewer (read-only) and client (customer, review-only)
// cannot edit workspace/strategy data. Mirrors the collection rules.
function assertWorkspaceWriter(actor) {
  if (actor.role === "viewer" || actor.role === "client") fail(403, "FORBIDDEN", "You do not have permission to edit this data.");
}

function assertOrg(record, actor, label) {
  if (!record || record.organization !== actor.organization) fail(404, "NOT_FOUND", label + " not found.");
  return record;
}

// ---------------------------------------------------------------- activity

function logActivity(app, entry) {
  createRec("activity_logs", {
    organization: entry.organization,
    user: entry.user || "",
    client: entry.client || "",
    website: entry.website || "",
    action: entry.action,
    entity_type: entry.entity_type || "",
    entity_id: entry.entity_id || "",
    metadata: entry.metadata || {},
    created_at: now(),
  }, app);
}

function articleActivity(app, article, actor, action, metadata) {
  logActivity(app, {
    organization: article.organization, client: article.client, website: article.website, user: actor ? actor.id : "",
    action: action, entity_type: "article", entity_id: article.id, metadata: metadata || {},
  });
}

// Best-effort logger for record hooks: the primary mutation already succeeded.
function safeLog(entry) {
  try {
    if (!entry.organization) return;
    logActivity($app, entry);
  } catch (err) {
    $app.logger().error("activity log failed", "action", entry.action, "error", String(err));
  }
}

function requestUser(e) {
  const auth = e.auth;
  if (!auth || auth.isSuperuser() || auth.collection().name !== "users") return null;
  return auth;
}

// ---------------------------------------------------------------- content: inputs

function validateInputs(raw) {
  raw = raw || {};
  const content_type = String(raw.content_type || "");
  if (CONTENT_TYPES.indexOf(content_type) === -1) fail(400, "INVALID", "Invalid content type.");
  const primary_keyword = clean(raw.primary_keyword, 200);
  if (primary_keyword.length < 2) fail(400, "INVALID", "Primary keyword is required.");
  const target_location = clean(raw.target_location, 200);
  if (content_type === "location_page" && !target_location) fail(400, "INVALID", "Location pages require a target location.");
  const recommended_url = clean(raw.recommended_url, 500);
  if (recommended_url && !/^(\/|https?:\/\/)[^\s<>"']*$/.test(recommended_url)) fail(400, "INVALID", "Recommended URL must be a path (/...) or http(s) URL.");
  const language = clean(raw.language, 10).toLowerCase();
  if (!/^[a-z]{2}(-[a-z]{2})?$/.test(language)) fail(400, "INVALID", "Language must be an ISO code like es or en-US.");
  return {
    content_type: content_type, primary_keyword: primary_keyword, target_location: target_location,
    recommended_url: recommended_url, reason: clean(raw.reason, 1500), language: language,
    pause_after_brief: raw.pause_after_brief === true || raw.pause_after_brief === "on" || raw.pause_after_brief === "true",
  };
}

function generationKey(source) {
  return (source.kind === "opportunity" ? "opp" : "plan") + ":" + source.id;
}

function findExistingArticle(key, opportunityId) {
  const direct = findFirst("articles", "generation_key = {:k}", "", { k: key });
  if (direct) return direct;
  if (!opportunityId) return null;
  return findFirst("articles", "content_opportunity = {:o} && status != 'rejected'", "-created_at", { o: opportunityId });
}

function resolveSource(actor, websiteId, source) {
  if (!source || (source.kind !== "opportunity" && source.kind !== "plan_item")) fail(400, "INVALID", "Missing generation source.");
  const website = assertOrg(getOne("websites", websiteId), actor, "Website");
  const collection = source.kind === "opportunity" ? "content_opportunities" : "content_plan_items";
  const record = assertOrg(getOne(collection, source.id), actor, source.kind === "opportunity" ? "Opportunity" : "Plan item");
  if (record.website !== website.id || record.client !== website.client) fail(404, "NOT_FOUND", "Source does not belong to this website.");
  const approved = source.kind === "opportunity" ? ["approved"] : ["approved", "in_progress"];
  if (approved.indexOf(String(record.status)) === -1) fail(409, "NOT_APPROVED", "Only approved opportunities or plan items can generate content.");
  if (source.kind === "opportunity" && ["internal_link", "ignore"].indexOf(String(record.opportunity_type)) !== -1) fail(400, "UNSUPPORTED", "This opportunity type does not generate content.");
  if (source.kind === "plan_item" && ["add_internal_links", "fix_technical_issue", "ignore"].indexOf(String(record.action)) !== -1) fail(400, "UNSUPPORTED", "This plan action does not generate content.");
  let opportunity = source.kind === "opportunity" ? record : null;
  if (!opportunity && record.opportunity) {
    const linked = getOne("content_opportunities", String(record.opportunity));
    if (linked && linked.organization === actor.organization && linked.website === website.id) opportunity = linked;
  }
  const keywordId = String(record.keyword || (opportunity && opportunity.keyword) || "");
  const keyword = keywordId ? getOne("keywords", keywordId) : null;
  if (keyword && keyword.website !== website.id) fail(404, "NOT_FOUND", "Keyword does not belong to this website.");
  const client = assertOrg(getOne("clients", String(website.client)), actor, "Client");
  if (client.id !== website.client) fail(404, "NOT_FOUND", "Client not found.");
  return { website: website, client: client, record: record, opportunity: opportunity, keyword: keyword };
}

function rateLimit() {
  const n = Number($os.getenv("CONTENT_JOBS_PER_HOUR") || 30);
  return n > 0 ? n : 30;
}

function assertRateLimit(organization) {
  const limit = rateLimit();
  const since = new Date(Date.now() - 3600000).toISOString().replace("T", " ");
  const recent = findMany("content_jobs", "organization = {:o} && created_at >= {:s}", "", limit, { o: organization, s: since });
  if (recent.length >= limit) fail(429, "RATE_LIMITED", "Content generation limit reached (" + limit + "/hour). Try again later.");
}

function activeJob(articleId, app) {
  return findFirst("content_jobs", "article = {:a} && (status = 'queued' || status = 'running')", "", { a: articleId }, app);
}

function insertJob(app, article, actor, fields) {
  const ts = now();
  const data = {
    organization: article.organization, client: article.client, website: article.website, article: article.id,
    opportunity: article.content_opportunity || "", plan_item: article.content_plan_item || "",
    status: "queued", step: "queued", progress: 0, triggered_by: actor.id, attempt: 0, created_at: ts, updated_at: ts,
  };
  for (const key of Object.keys(fields)) data[key] = fields[key];
  return createRec("content_jobs", data, app);
}

function createJob(article, actor, fields) {
  const existing = activeJob(article.id);
  if (existing) return existing;
  assertRateLimit(actor.organization);
  try {
    return insertJob($app, article, actor, fields);
  } catch (err) {
    const winner = activeJob(article.id); // partial unique index lost a race
    if (winner) return winner;
    throw err;
  }
}

// ---------------------------------------------------------------- content: operations

function startGeneration(actor, body) {
  assertContentWriter(actor);
  const websiteId = String(body.websiteId || "");
  const source = { kind: String((body.source && body.source.kind) || ""), id: String((body.source && body.source.id) || "") };
  const resolved = resolveSource(actor, websiteId, source);
  const website = resolved.website;
  const record = resolved.record;
  const opportunity = resolved.opportunity;
  const keyword = resolved.keyword;
  const inputs = validateInputs(body.inputs);
  const key = generationKey(source);
  const found = findExistingArticle(key, opportunity ? opportunity.id : "");
  if (found) {
    const article = assertOrg(found, actor, "Article");
    return { article: article, job: activeJob(article.id), created: false };
  }
  const existingPageId = String(record.existing_page || (opportunity && opportunity.existing_page) || "");
  if (inputs.content_type === "existing_page_optimization" && !existingPageId) fail(400, "INVALID", "Existing page optimization requires an opportunity linked to an existing page.");
  assertRateLimit(actor.organization);

  const ts = now();
  let result = null;
  try {
    $app.runInTransaction(function (tx) {
      const article = createRec("articles", {
        organization: actor.organization, client: website.client, website: website.id,
        content_opportunity: opportunity ? opportunity.id : "", content_plan_item: source.kind === "plan_item" ? record.id : "",
        keyword: keyword ? keyword.id : "", cluster: String(record.cluster || (opportunity && opportunity.cluster) || ""),
        existing_page: inputs.content_type === "existing_page_optimization" ? existingPageId : "",
        content_type: inputs.content_type, status: "researching", language: inputs.language,
        primary_keyword: inputs.primary_keyword, target_location: inputs.target_location, recommended_url: inputs.recommended_url,
        secondary_keywords: [], flags: [], risk_categories: [], pipeline_state: {}, revision_cycles: 0, current_version: 0,
        qa_status: "pending", fact_check_status: "pending", content_format: "markdown",
        generation_key: key, generation_input: Object.assign({}, inputs, { source: source }), created_by: actor.id,
        author: clean(actor.name || actor.email, 200), created_at: ts, updated_at: ts,
      }, tx);
      const job = insertJob(tx, article, actor, { mode: "generate", configuration: { pause_after_brief: Boolean(inputs.pause_after_brief) } });
      if (source.kind === "plan_item" && record.status === "approved") updateRec("content_plan_items", record.id, { status: "in_progress", updated_at: ts }, tx);
      articleActivity(tx, article, actor, "CONTENT_GENERATION_STARTED", { source: key, content_type: inputs.content_type, job: job.id });
      result = { article: article, job: job, created: true };
    });
  } catch (err) {
    // Concurrent click won the unique generation_key: return the winner.
    const again = findFirst("articles", "generation_key = {:k}", "", { k: key });
    if (again && again.organization === actor.organization) return { article: again, job: activeJob(again.id), created: false };
    throw err;
  }
  return result;
}

function articleFor(actor, articleId) {
  return assertOrg(getOne("articles", String(articleId || "")), actor, "Article");
}

function retryGeneration(actor, body) {
  assertContentWriter(actor);
  const article = articleFor(actor, body.articleId);
  if (["approved", "rejected"].indexOf(String(article.status)) !== -1) fail(409, "INVALID_STATE", "Approved or rejected content cannot be regenerated.");
  const running = activeJob(article.id);
  if (running) return running;
  const last = findFirst("content_jobs", "article = {:a}", "-created_at", { a: article.id });
  if (article.status === "needs_revision" && last && last.status === "completed") return regenerateArticle(actor, article, body, last);
  if (!last || last.status !== "failed") fail(409, "INVALID_STATE", "Only failed jobs or articles that need revision can be retried.");
  const mode = last.mode === "revision" ? "revision" : last.mode === "recheck" ? "recheck" : "continue";
  const job = createJob(article, actor, { mode: mode, configuration: last.configuration || {}, revision_instruction: last.revision_instruction || "", attempt: Number(last.attempt || 0) + 1 });
  updateRec("articles", article.id, { status: article.content ? article.status : "researching", updated_at: now() });
  articleActivity($app, article, actor, "CONTENT_RETRY_QUEUED", { job: job.id, mode: mode });
  return job;
}

// Retry on an article that exhausted its automatic revisions: rerun the whole
// pipeline on the SAME article (new research, brief, outline and a new draft
// version). Previous versions, claims, QA reports, sources and usage records
// are kept; the worker archives the prior brief/outline/research snapshot.
// Optional keyword/location alignment is validated like generation inputs.
function regenerateArticle(actor, article, body, last) {
  const ts = now();
  const changes = { status: "researching", updated_at: ts };
  const keyword = body.primary_keyword === undefined ? "" : clean(body.primary_keyword, 200);
  const location = body.target_location === undefined ? null : clean(body.target_location, 200);
  if (body.primary_keyword !== undefined && keyword.length < 2) fail(400, "INVALID", "Primary keyword is required.");
  if (keyword) changes.primary_keyword = keyword;
  if (location !== null) changes.target_location = location;
  if (article.content_type === "location_page" && location === "") fail(400, "INVALID", "Location pages require a target location.");
  assertRateLimit(actor.organization);
  let job = null;
  $app.runInTransaction(function (tx) {
    const cfg = Object.assign({}, last.configuration || {}, { regenerate: true, pause_after_brief: false });
    job = insertJob(tx, article, actor, { mode: "generate", configuration: cfg, attempt: Number(last.attempt || 0) + 1 });
    updateRec("articles", article.id, changes, tx);
    articleActivity(tx, article, actor, "CONTENT_REGENERATION_QUEUED", {
      job: job.id, from_version: Number(article.current_version || 0),
      primary_keyword: { from: String(article.primary_keyword || ""), to: changes.primary_keyword || String(article.primary_keyword || "") },
      target_location: { from: String(article.target_location || ""), to: changes.target_location === undefined ? String(article.target_location || "") : changes.target_location },
    });
  });
  return job;
}

function continueAfterBrief(actor, body) {
  assertContentWriter(actor);
  const article = articleFor(actor, body.articleId);
  if (article.status !== "brief_ready") fail(409, "INVALID_STATE", "The article is not waiting on brief review.");
  return createJob(article, actor, { mode: "continue", configuration: { pause_after_brief: false } });
}

function requestRecheck(actor, body) {
  assertContentWriter(actor);
  const article = articleFor(actor, body.articleId);
  if (!article.content) fail(409, "INVALID_STATE", "There is no draft to check.");
  if (["approved", "rejected"].indexOf(String(article.status)) !== -1) fail(409, "INVALID_STATE", "Approved or rejected content is locked.");
  return createJob(article, actor, { mode: "recheck" });
}

function cancelJob(actor, body) {
  assertContentWriter(actor);
  const job = assertOrg(getOne("content_jobs", String(body.jobId || "")), actor, "Job");
  if (job.status !== "queued") fail(409, "INVALID_STATE", "Only queued jobs can be cancelled.");
  updateRec("content_jobs", job.id, { status: "cancelled", step: "cancelled", completed_at: now(), updated_at: now() });
  return { ok: true };
}

function saveBrief(actor, body) {
  assertContentWriter(actor);
  const article = articleFor(actor, body.articleId);
  if (["brief_ready", "outline_ready"].indexOf(String(article.status)) === -1) fail(409, "INVALID_STATE", "The brief can only be edited before drafting.");
  const text = String(body.brief || "");
  if (text.length > 200000) fail(400, "INVALID", "Brief is too large.");
  let brief;
  try { brief = JSON.parse(text); } catch (_) { fail(400, "INVALID", "Brief must be valid JSON."); }
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) fail(400, "INVALID", "Brief must be a JSON object.");
  brief.edited_by_human = true;
  const state = Object.assign({}, article.pipeline_state || {}, { outline: false });
  updateRec("articles", article.id, { brief: brief, outline: null, pipeline_state: state, status: "brief_ready", updated_at: now() });
  articleActivity($app, article, actor, "BRIEF_EDITED", {});
  return { ok: true };
}

function nextVersion(articleId, app) {
  const latest = findFirst("article_versions", "article = {:a}", "-version", { a: articleId }, app);
  return (Number(latest && latest.version) || 0) + 1;
}

function writeVersion(app, article, fields, changeType, reason, actor) {
  const version = nextVersion(article.id, app);
  createRec("article_versions", {
    organization: article.organization, client: article.client, website: article.website, article: article.id, version: version,
    title: fields.title, content: fields.content, seo_title: fields.seo_title, meta_description: fields.meta_description,
    excerpt: fields.excerpt, slug: fields.slug, change_type: changeType, change_reason: clean(reason, 2000),
    created_by: actor ? actor.id : "", created_by_label: clean(actor ? (actor.name || actor.email) : "", 200), created_at: now(),
  }, app);
  return version;
}

function snapshot(article) {
  const out = {};
  for (const f of EDITABLE) out[f] = String(article[f] === undefined || article[f] === null ? "" : article[f]);
  return out;
}

// Version + article update commit together, so content is never overwritten
// without history. A unique (article, version) race rolls back and retries.
function versionedUpdate(article, fields, changeType, reason, actor, extra) {
  let version = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      $app.runInTransaction(function (tx) {
        version = writeVersion(tx, article, fields, changeType, reason, actor);
        updateRec("articles", article.id, Object.assign({}, fields, { current_version: version, updated_at: now() }, extra || {}), tx);
      });
      return version;
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
  return version;
}

function saveManualEdit(actor, body) {
  assertContentWriter(actor);
  const article = articleFor(actor, body.articleId);
  if (["approved", "rejected"].indexOf(String(article.status)) !== -1) fail(409, "INVALID_STATE", "Approved or rejected content is locked. Request a revision instead.");
  if (activeJob(article.id)) fail(409, "BUSY", "A content job is running for this article. Wait for it to finish before editing.");
  const raw = body.fields || {};
  const next = {};
  for (const field of EDITABLE) {
    const value = raw[field];
    if (value === undefined || value === null) next[field] = String(article[field] || "");
    else next[field] = field === "content" ? String(value).replace(/\r\n/g, "\n").slice(0, LIMITS[field]) : clean(value, LIMITS[field]);
  }
  if (next.slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(next.slug)) fail(400, "INVALID", "Slug must be lowercase letters, numbers and hyphens.");
  const before = snapshot(article);
  if (EDITABLE.every(function (f) { return before[f] === next[f]; })) return { changed: false };
  const reason = clean(body.reason, 2000) || "Manual edit";
  const version = versionedUpdate(article, next, "manual_edit", reason, actor, { status: "draft", qa_status: "stale", fact_check_status: "stale" });
  articleActivity($app, article, actor, "ARTICLE_EDITED", { version: version, reason: reason, fields: EDITABLE.filter(function (f) { return before[f] !== next[f]; }) });
  return { changed: true, version: version };
}

function restoreVersion(actor, body) {
  assertContentWriter(actor);
  const article = articleFor(actor, body.articleId);
  if (["approved", "rejected"].indexOf(String(article.status)) !== -1) fail(409, "INVALID_STATE", "Approved or rejected content is locked.");
  if (activeJob(article.id)) fail(409, "BUSY", "A content job is running for this article.");
  const wanted = Number(body.version) | 0;
  const source = findFirst("article_versions", "article = {:a} && version = {:v}", "", { a: article.id, v: wanted });
  if (!source || source.organization !== actor.organization || source.article !== article.id) fail(404, "NOT_FOUND", "Version not found.");
  const fields = snapshot(source);
  const version = versionedUpdate(article, fields, "restore", "Restored version " + source.version, actor, { status: "draft", qa_status: "stale", fact_check_status: "stale" });
  articleActivity($app, article, actor, "ARTICLE_VERSION_RESTORED", { restored_from: source.version, version: version });
  return { version: version };
}

function approvalBlockers(article) {
  const blockers = [];
  if (article.status !== "awaiting_approval") blockers.push("Status is " + article.status + "; only content awaiting approval can be approved.");
  if (article.qa_status === "BLOCKED") blockers.push("QA is BLOCKED.");
  if (article.qa_status === "stale" || article.qa_status === "pending") blockers.push("QA has not run on the current version.");
  if (article.fact_check_status === "blocked") blockers.push("Fact check found high-risk unsupported or contradicted claims.");
  const flags = article.flags || [];
  if (flags.indexOf("RESEARCH_REQUIRED") !== -1) blockers.push("Research is required before this topic can be approved.");
  if (flags.indexOf("LANGUAGE_MISMATCH") !== -1) blockers.push("Draft language does not match the configured language.");
  if (!String(article.content || "").trim()) blockers.push("There is no content.");
  return blockers;
}

function approveArticle(actor, body) {
  assertContentWriter(actor);
  const article = articleFor(actor, body.articleId);
  const blockers = approvalBlockers(article);
  if (blockers.length) fail(409, "NOT_APPROVABLE", blockers.join(" "));
  const ackHighRisk = body.acknowledgeHighRisk === true;
  const ackWarnings = body.acknowledgeWarnings === true;
  if (article.high_risk && !ackHighRisk) fail(409, "HIGH_RISK_REVIEW_REQUIRED", "High-risk content: confirm you reviewed the medical/legal/financial/safety claims.");
  if (article.qa_status === "NEEDS_REVISION" && !ackWarnings) fail(409, "WARNINGS_NOT_ACKNOWLEDGED", "QA still reports issues after the automatic revision limit. Confirm you reviewed them to approve.");
  const ts = now();
  const provenance = Object.assign({}, article.provenance || {}, { approved_version: article.current_version, auto_publish_allowed: false, high_risk_acknowledged: Boolean(article.high_risk && ackHighRisk) });
  let updated = null;
  $app.runInTransaction(function (tx) {
    updated = updateRec("articles", article.id, { status: "approved", approved_by: actor.id, approved_at: ts, provenance: provenance, updated_at: ts }, tx);
    articleActivity(tx, article, actor, "ARTICLE_APPROVED", { version: article.current_version, qa_status: article.qa_status, high_risk: Boolean(article.high_risk) });
  });
  return updated;
}

function rejectArticle(actor, body) {
  assertContentWriter(actor);
  const why = clean(body.reason, 2000);
  if (why.length < 3) fail(400, "INVALID", "A rejection reason is required.");
  const article = articleFor(actor, body.articleId);
  if (article.status === "approved") fail(409, "INVALID_STATE", "Approved content cannot be rejected in Phase 4.");
  if (activeJob(article.id)) fail(409, "BUSY", "A content job is running for this article.");
  const ts = now();
  let updated = null;
  $app.runInTransaction(function (tx) {
    updated = updateRec("articles", article.id, { status: "rejected", rejected_by: actor.id, rejected_at: ts, rejection_reason: why, updated_at: ts }, tx);
    articleActivity(tx, article, actor, "ARTICLE_REJECTED", { reason: why });
  });
  return updated;
}

function requestRevision(actor, body) {
  assertContentWriter(actor);
  const text = clean(body.instruction, 2000);
  if (text.length < 3) fail(400, "INVALID", "Write a revision instruction.");
  const article = articleFor(actor, body.articleId);
  if (!article.content) fail(409, "INVALID_STATE", "There is no draft to revise yet.");
  if (article.status === "rejected") fail(409, "INVALID_STATE", "Rejected content cannot be revised.");
  if (activeJob(article.id)) fail(409, "BUSY", "Another job is already running for this article; try again when it finishes.");
  assertRateLimit(actor.organization);
  let job = null;
  $app.runInTransaction(function (tx) {
    const patch = { status: "needs_revision", updated_at: now() };
    if (article.status === "approved") { patch.approved_by = ""; patch.approved_at = ""; } // re-open; nothing was published
    updateRec("articles", article.id, patch, tx);
    job = insertJob(tx, article, actor, { mode: "revision", revision_instruction: text, configuration: {} });
    articleActivity(tx, article, actor, "REVISION_REQUESTED", { instruction: text, job: job.id, previous_status: article.status });
  });
  return job;
}

// ---------------------------------------------------------------- strategy (Phase 3)

const STRATEGY_COLLECTIONS = {
  keywords: "keywords",
  clusters: "topic_clusters",
  opportunities: "content_opportunities",
  cannibalization: "cannibalization_issues",
  internalLinks: "content_opportunities",
  plan: "content_plan_items",
};

function updateStrategyRecord(actor, body) {
  assertWorkspaceWriter(actor);
  const key = String(body.collection || "");
  const collection = STRATEGY_COLLECTIONS[key];
  if (!collection) fail(400, "INVALID", "Unknown strategy collection.");
  const website = assertOrg(getOne("websites", String(body.websiteId || "")), actor, "Website");
  const record = getOne(collection, String(body.recordId || ""));
  if (!record || record.organization !== actor.organization || record.client !== website.client || record.website !== website.id) fail(404, "NOT_FOUND", "Strategy record not found.");
  const operation = String(body.operation || "");
  const value = String(body.value === undefined || body.value === null ? "" : body.value);
  const data = {};
  let changedField = "status";
  if (operation === "approve") data.status = key === "cannibalization" ? "reviewed" : "approved";
  else if (operation === "ignore") data.status = key === "clusters" ? "archived" : (key === "opportunities" || key === "internalLinks") ? "skipped" : "ignored";
  else if (operation === "skip" && key === "plan") data.status = "skipped";
  else if (operation === "change_intent") {
    if (["informational", "navigational", "commercial", "transactional", "local", "mixed"].indexOf(value) === -1) fail(400, "INVALID", "Invalid intent.");
    data.intent = value; changedField = "intent";
  } else if (operation === "change_cluster") {
    data.cluster = value.slice(0, 200); changedField = "cluster";
  } else if (operation === "change_priority") {
    if (["critical", "high", "medium", "low"].indexOf(value) === -1) fail(400, "INVALID", "Invalid priority.");
    data.priority = value; changedField = "priority";
  } else if (operation === "change_action") {
    if (key === "cannibalization") { changedField = "recommended_action"; data[changedField] = value.trim().slice(0, 1000); }
    else if (key === "opportunities" || key === "internalLinks") {
      if (["create", "optimize", "expand", "merge", "internal_link", "location", "service", "refresh", "ignore"].indexOf(value.trim()) === -1) fail(400, "INVALID", "Invalid action.");
      changedField = "opportunity_type"; data[changedField] = value.trim();
    } else fail(400, "INVALID", "Unsupported change.");
  } else fail(400, "INVALID", "Unsupported operation.");
  if (changedField === "cluster" && data.cluster) {
    const cluster = getOne("topic_clusters", data.cluster);
    if (!cluster || cluster.website !== website.id || cluster.organization !== actor.organization) fail(404, "NOT_FOUND", "Cluster not found.");
  }
  const manual = record.manual_fields || [];
  if (manual.indexOf(changedField) === -1) manual.push(changedField);
  data.manual_override = true;
  data.manual_fields = manual;
  data.overridden_by = actor.id;
  data.overridden_at = now();
  data.updated_at = now();
  $app.runInTransaction(function (tx) {
    updateRec(collection, record.id, data, tx);
    logActivity(tx, {
      organization: actor.organization, client: website.client, website: website.id, user: actor.id,
      action: operation === "approve" && collection === "content_opportunities" ? "OPPORTUNITY_APPROVED" : "STRATEGY_RECORD_UPDATED",
      entity_type: collection, entity_id: record.id,
      metadata: { operation: operation, field: changedField, from: record[changedField] === undefined ? null : record[changedField], to: data[changedField] },
    });
  });
  return { ok: true };
}

// ---------------------------------------------------------------- organization / session

function updateOrganization(actor, body) {
  if (actor.role !== "admin" && actor.role !== "super_admin") fail(403, "FORBIDDEN", "Only organization admins can rename the organization.");
  const name = clean(body.name, 200);
  if (name.length < 2) fail(400, "INVALID", "Organization name is required.");
  const org = getOne("organizations", actor.organization);
  if (!org) fail(404, "NOT_FOUND", "Organization not found.");
  $app.runInTransaction(function (tx) {
    updateRec("organizations", org.id, { name: name }, tx);
    logActivity(tx, { organization: org.id, user: actor.id, action: "ORGANIZATION_UPDATED", entity_type: "organization", entity_id: org.id, metadata: { from: org.name, to: name } });
  });
  return { ok: true };
}

// Logout invalidation: rotating the token key revokes every token issued for
// this user (all devices), so a copied cookie stops working immediately.
function logout(e) {
  const auth = requestUser(e);
  if (!auth) fail(401, "UNAUTHENTICATED", "Sign in to continue.");
  const org = auth.getString("organization");
  $app.runInTransaction(function (tx) {
    const user = tx.findRecordById("users", auth.id);
    user.refreshTokenKey();
    tx.save(user);
    if (org) logActivity(tx, { organization: org, user: auth.id, action: "USER_LOGOUT", entity_type: "user", entity_id: auth.id, metadata: {} });
  });
  return { ok: true };
}

// ---------------------------------------------------------------- HTTP glue

function handle(e, fn) {
  try {
    const body = e.requestInfo().body || {};
    const actor = actorOf(e);
    return e.json(200, fn(actor, body) || { ok: true });
  } catch (err) {
    if (err && err.bsa) return e.json(err.bsa.status, { code: err.bsa.code, message: err.bsa.message });
    $app.logger().error("bsa operation failed", "path", e.request.url.path, "error", String(err));
    return e.json(500, { code: "INTERNAL", message: "The operation failed. Please try again." });
  }
}

module.exports = {
  CONTENT_TYPES, now, clean, fail, toObj, getOne, findFirst, requestUser, safeLog, handle, logout,
  validateInputs, approvalBlockers, startGeneration, retryGeneration, continueAfterBrief, requestRecheck, cancelJob,
  saveBrief, saveManualEdit, restoreVersion, approveArticle, rejectArticle, requestRevision,
  updateStrategyRecord, updateOrganization,
};
