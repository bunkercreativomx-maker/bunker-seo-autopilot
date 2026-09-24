// Bunker SEO Autopilot — Phase 5 publishing operations (user-scoped).
//
// These run INSIDE PocketBase with the signed-in user's token (see
// bsa_routes.pb.js). They never contact external websites: every outbound
// request (connection test, publish, verify, unpublish) is performed by the
// independent bunker-seo-publisher worker, which polls publish_jobs.
//
// Invariants enforced here:
// - Only approved content can be queued, and only the exact approved snapshot
//   (version + hash). Any change after approval requires re-approval.
// - The target website is ALWAYS the article's own website record; a request
//   can never redirect publication to another website/client/org.
// - Idempotency: one active job per article, and a deterministic
//   idempotency_key per (operation, article, website, version, hash, sequence).
// - Secrets are encrypted at rest and never returned after saving (a generated
//   secret is shown exactly once, in the response that created it).
//
// JSVM: handlers run in isolated VMs; require this file inside each handler.

const PUBLISHER_TYPES = ["pocketbase_cms", "nextjs_api", "webhook", "wordpress"];
const ACTIVE_JOB = ["queued", "validating", "publishing", "verifying", "unpublishing"];
const SNAPSHOT_FIELDS = ["title", "slug", "seo_title", "meta_description", "excerpt", "content", "og_title", "og_description", "canonical_url", "featured_image", "structured_data", "language", "content_type"];
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|\[?fe80:|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/i;

function lib() {
  return require(`${__hooks}/bsa_lib.js`);
}

// ---------------------------------------------------------------- hashing
// Canonical JSON (sorted keys, recursive) so Node (worker) and the JSVM
// produce the same digest for the same snapshot.
function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map(function (k) { return JSON.stringify(k) + ":" + stableStringify(value[k]); }).join(",") + "}";
  }
  return JSON.stringify(value);
}

function snapshotOf(article) {
  const out = { version: Number(article.current_version || 0) };
  for (const f of SNAPSHOT_FIELDS) {
    const v = article[f];
    if (f === "structured_data") out[f] = v === undefined || v === "" ? null : v;
    else out[f] = String(v === undefined || v === null ? "" : v);
  }
  return out;
}

function snapshotHash(snapshot) {
  return $security.sha256(stableStringify(snapshot));
}

// ---------------------------------------------------------------- secrets
function encKey() {
  const path = $os.getenv("PUBLISHING_KEY_FILE") || "/pb_secrets/publishing.key";
  let key = "";
  try { key = toString($os.readFile(path)).trim(); } catch (_) { key = ""; }
  if (key.length !== 32) lib().fail(503, "SECRETS_UNAVAILABLE", "Publishing secrets storage is not configured on the server.");
  return key;
}

// Private/loopback targets are refused. The ONLY exception is an explicit
// host:port allowlist (used by local integration tests against a loopback
// sandbox site); it is never set in production.
function privateAllowlisted(host, port) {
  const list = String($os.getenv("BSA_PUBLISH_PRIVATE_ALLOWLIST") || "").split(",").map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
  return list.indexOf(host + ":" + port) !== -1;
}

function rateLimitJobs(organization) {
  const L = lib();
  const limit = Math.max(1, Number($os.getenv("PUBLISH_JOBS_PER_HOUR") || 60));
  const since = new Date(Date.now() - 3600000).toISOString().replace("T", " ");
  const recent = L.findMany("publish_jobs", "organization = {:o} && created_at >= {:s}", "", limit, { o: organization, s: since });
  if (recent.length >= limit) L.fail(429, "RATE_LIMITED", "Publishing limit reached (" + limit + "/hour). Try again later.");
}

// ---------------------------------------------------------------- access
function assertPublisher(actor) {
  if (actor.role === "viewer" || actor.role === "client") lib().fail(403, "FORBIDDEN", "You do not have permission to publish content.");
}

function assertIntegrationAdmin(actor) {
  if (actor.role !== "admin" && actor.role !== "super_admin") lib().fail(403, "FORBIDDEN", "Only organization admins can configure publishing integrations.");
}

function websiteFor(actor, websiteId) {
  const L = lib();
  const w = L.getOne("websites", String(websiteId || ""));
  if (!w || w.organization !== actor.organization) L.fail(404, "NOT_FOUND", "Website not found.");
  const client = L.getOne("clients", String(w.client || ""));
  if (!client || client.organization !== actor.organization) L.fail(404, "NOT_FOUND", "Website not found.");
  return w;
}

function articleFor(actor, articleId, websiteId) {
  const L = lib();
  const a = L.getOne("articles", String(articleId || ""));
  if (!a || a.organization !== actor.organization) L.fail(404, "NOT_FOUND", "Article not found.");
  // The publication target is ALWAYS the article's own website. A request
  // naming another website (even one of the same org) is refused.
  if (websiteId !== undefined && websiteId !== null && websiteId !== "" && String(websiteId) !== a.website) L.fail(409, "WEBSITE_MISMATCH", "The article belongs to a different website; the publishing target cannot be changed.");
  const w = websiteFor(actor, a.website);
  if (w.client !== a.client) L.fail(409, "TENANT_MISMATCH", "Article and website belong to different clients.");
  return { article: a, website: w };
}

function integrationOf(websiteId) {
  return lib().findFirst("integrations", "website = {:w} && kind = 'publishing'", "", { w: websiteId });
}

function publicationOf(articleId, websiteId) {
  return lib().findFirst("article_publications", "article = {:a} && website = {:w}", "", { a: articleId, w: websiteId });
}

function activeJob(articleId) {
  return lib().findFirst("publish_jobs", "article = {:a} && (" + ACTIVE_JOB.map(function (s) { return "status = '" + s + "'"; }).join(" || ") + ")", "", { a: articleId });
}

// ---------------------------------------------------------------- config
function normalizeDomain(value) {
  return String(value || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
}

function hostAllowed(host, allowed) {
  host = normalizeDomain(host);
  for (const d of allowed) if (host === d) return true;
  return false;
}

function validateTargetUrl(label, raw, allowed, required) {
  const L = lib();
  const value = L.clean(raw, 500);
  if (!value) {
    if (required) L.fail(400, "INVALID", label + " is required.");
    return "";
  }
  const m = /^(https?):\/\/([^/?#:]+)(:\d+)?(\/[^\s?#]*)?$/i.exec(value);
  if (!m) L.fail(400, "INVALID", label + " must be an absolute http(s) URL without query string.");
  const host = m[2].toLowerCase();
  const port = m[3] ? m[3].slice(1) : (m[1].toLowerCase() === "https" ? "443" : "80");
  if (!privateAllowlisted(host, port)) {
    if (m[1].toLowerCase() !== "https") L.fail(400, "INVALID", label + " must use https.");
    if (PRIVATE_HOST_RE.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.indexOf(":") !== -1 || !/\./.test(host)) L.fail(400, "SSRF_BLOCKED", label + " must be a public hostname.");
  }
  if (!hostAllowed(host, allowed)) L.fail(400, "DOMAIN_NOT_ALLOWED", label + " host " + host + " is not in the allowed domains list.");
  return value.replace(/\/+$/, "");
}

function saveConfig(actor, body) {
  const L = lib();
  assertIntegrationAdmin(actor);
  const website = websiteFor(actor, body.websiteId);
  const type = String(body.publisherType || "");
  if (PUBLISHER_TYPES.indexOf(type) === -1) L.fail(400, "INVALID", "Unknown publisher type.");
  const mode = String(body.publishingMode || "manual");
  if (mode === "autopilot_future") L.fail(400, "INVALID", "Autopilot publishing is not available in Phase 5.");
  if (mode !== "manual" && mode !== "approval") L.fail(400, "INVALID", "Invalid publishing mode.");
  const environment = String(body.environment || "staging");
  if (environment !== "staging" && environment !== "production") L.fail(400, "INVALID", "Invalid environment.");
  const allowed = [];
  for (const d of (Array.isArray(body.allowedDomains) ? body.allowedDomains : String(body.allowedDomains || "").split(/[\s,]+/))) {
    const n = normalizeDomain(d);
    if (!n) continue;
    if (!/^[a-z0-9.-]+$/.test(n) || n.indexOf("..") !== -1) L.fail(400, "INVALID", "Invalid allowed domain: " + n);
    if (allowed.indexOf(n) === -1) allowed.push(n);
  }
  if (!allowed.length) L.fail(400, "INVALID", "At least one allowed domain is required.");
  if (allowed.length > 10) L.fail(400, "INVALID", "Too many allowed domains.");
  const baseUrl = validateTargetUrl("Base URL", body.baseUrl, allowed, true);
  const apiEndpoint = validateTargetUrl("API endpoint", body.apiEndpoint, allowed, type === "nextjs_api" || type === "webhook" || type === "wordpress");
  const revalidateUrl = validateTargetUrl("Revalidation URL", body.revalidateUrl, allowed, false);
  let blogPath = L.clean(body.blogPath === undefined ? "/blog" : body.blogPath, 200);
  if (blogPath && !/^\/[a-z0-9\-_/]*$/i.test(blogPath)) L.fail(400, "INVALID", "Blog path must look like /blog.");
  blogPath = blogPath.replace(/\/+$/, "");
  const cfg = {
    revalidate_url: revalidateUrl,
    verify_sitemap: body.verifySitemap !== false,
    sitemap_url: validateTargetUrl("Sitemap URL", body.sitemapUrl, allowed, false),
    wordpress_status: body.wordpressStatus === "draft" ? "draft" : "publish",
    wordpress_seo_plugin: ["none", "yoast", "rankmath"].indexOf(String(body.wordpressSeoPlugin || "none")) === -1 ? "none" : String(body.wordpressSeoPlugin || "none"),
  };
  const enabled = body.enabled === true;
  const ts = L.now();
  const existing = integrationOf(website.id);
  const secretReady = Boolean(existing && existing.secret_last4);
  const typeChanged = website.publisher_type !== type || website.base_url !== baseUrl || website.api_endpoint !== apiEndpoint;
  $app.runInTransaction(function (tx) {
    L.updateRec("websites", website.id, {
      publishing_enabled: enabled, publisher_type: type, publishing_mode: mode, publishing_environment: environment,
      base_url: baseUrl, blog_path: blogPath, api_endpoint: apiEndpoint, allowed_domains: allowed,
      publication_requires_approval: true, auto_revalidate: body.autoRevalidate === true,
      publishing_configuration: cfg,
      connection_status: typeChanged ? "not_configured" : (website.connection_status || "not_configured"),
    }, tx);
    if (existing) L.updateRec("integrations", existing.id, { publisher_type: type, status: enabled ? "active" : "disabled", username: L.clean(body.username, 200), config: cfg, updated_by: actor.id, updated_at: ts }, tx);
    else L.createRec("integrations", {
      organization: website.organization, client: website.client, website: website.id, kind: "publishing", publisher_type: type,
      status: enabled ? "active" : "disabled", username: L.clean(body.username, 200), config: cfg, updated_by: actor.id, created_at: ts, updated_at: ts,
    }, tx);
    L.logActivity(tx, { organization: website.organization, client: website.client, website: website.id, user: actor.id, action: "PUBLISHING_CONFIGURED", entity_type: "website", entity_id: website.id, metadata: { publisher_type: type, environment: environment, enabled: enabled, base_url: baseUrl, allowed_domains: allowed } });
  });
  return { ok: true, secret_configured: secretReady || type === "pocketbase_cms" };
}

// Generate or set the shared secret. Encrypted with a key that lives outside
// the database; hidden fields are never returned by the REST API. A generated
// secret is returned once so the operator can configure the target site.
function saveSecret(actor, body) {
  const L = lib();
  assertIntegrationAdmin(actor);
  const website = websiteFor(actor, body.websiteId);
  const integration = integrationOf(website.id);
  if (!integration) L.fail(409, "NOT_CONFIGURED", "Save the publishing configuration first.");
  let secret = "";
  let generated = false;
  if (body.generate === true) { secret = $security.randomString(48); generated = true; }
  else secret = String(body.secret || "");
  if (secret.length < 16 || secret.length > 500) L.fail(400, "INVALID", "Secret must be 16–500 characters.");
  const key = encKey();
  const grace = Math.max(0, Math.min(168, Number(body.graceHours || 0) | 0));
  const ts = L.now();
  const patch = { secret_encrypted: $security.encrypt(secret, key), secret_last4: secret.slice(-4), secret_set_at: ts, updated_by: actor.id, updated_at: ts };
  // Rotation: keep the previous secret for a bounded grace window so the target
  // can be switched without downtime. No code change required.
  const raw = $app.findRecordById("integrations", integration.id);
  const previous = raw.getString("secret_encrypted");
  if (previous && grace > 0) {
    patch.previous_secret_encrypted = previous;
    patch.previous_secret_valid_until = new Date(Date.now() + grace * 3600000).toISOString();
  } else {
    patch.previous_secret_encrypted = "";
    patch.previous_secret_valid_until = "";
  }
  $app.runInTransaction(function (tx) {
    L.updateRec("integrations", integration.id, patch, tx);
    L.updateRec("websites", website.id, { connection_status: "not_configured" }, tx);
    L.logActivity(tx, { organization: website.organization, client: website.client, website: website.id, user: actor.id, action: previous ? "PUBLISHING_SECRET_ROTATED" : "PUBLISHING_SECRET_SET", entity_type: "integration", entity_id: integration.id, metadata: { generated: generated, grace_hours: grace, last4: patch.secret_last4 } });
  });
  const out = { ok: true, last4: patch.secret_last4, rotated: Boolean(previous), grace_hours: grace };
  if (generated) out.secret = secret; // shown once, never retrievable again
  return out;
}

function queueJob(tx, fields) {
  rateLimitJobs(fields.organization);
  const ts = lib().now();
  const data = Object.assign({ status: "queued", attempt: 0, max_attempts: 3, requested_at: ts, next_attempt_at: ts, created_at: ts, updated_at: ts }, fields);
  return lib().createRec("publish_jobs", data, tx);
}

function testConnection(actor, body) {
  const L = lib();
  assertIntegrationAdmin(actor);
  const website = websiteFor(actor, body.websiteId);
  if (!website.publisher_type) L.fail(409, "NOT_CONFIGURED", "Configure a publisher first.");
  const running = L.findFirst("publish_jobs", "website = {:w} && operation = 'test_connection' && (status = 'queued' || status = 'validating' || status = 'publishing')", "", { w: website.id });
  if (running) return { id: running.id, status: running.status, created: false };
  let job = null;
  $app.runInTransaction(function (tx) {
    job = queueJob(tx, {
      organization: website.organization, client: website.client, website: website.id, operation: "test_connection",
      publisher_type: website.publisher_type, requested_by: actor.id, max_attempts: 1,
      idempotency_key: "test:" + website.id + ":" + $security.randomString(12),
    });
  });
  return { id: job.id, status: job.status, created: true };
}

// ---------------------------------------------------------------- validation
function blockersFor(article, website, integration, operation) {
  const b = [];
  const flags = article.flags || [];
  if (operation === "publish" || operation === "update" || operation === "republish") {
    // An unpublished article may be republished only if its human approval is
    // still intact (same version + hash checks below); any edit resets it.
    const statusOk = article.status === "approved" || article.status === "publish_failed" || (operation === "republish" && article.status === "unpublished");
    if (!statusOk) b.push("Article status is " + article.status + "; only approved content can be published.");
    if (!article.approved_by || !article.approved_at) b.push("The article has no recorded human approval.");
    if (!article.approved_hash || !article.approved_snapshot) b.push("No approved version snapshot exists; approve the article again.");
    else {
      if (Number(article.approved_version) !== Number(article.current_version)) b.push("The current version (v" + article.current_version + ") differs from the approved version (v" + article.approved_version + "); re-approval required.");
      if (snapshotHash(snapshotOf(article)) !== article.approved_hash) b.push("Content changed after approval; re-approval required.");
      if (snapshotHash(article.approved_snapshot) !== article.approved_hash) b.push("Approved snapshot integrity check failed.");
    }
    if (article.fact_check_status !== "passed") b.push("Fact check has not passed on the approved version.");
    if (article.qa_status === "BLOCKED" || article.qa_status === "stale" || article.qa_status === "pending") b.push("QA is " + article.qa_status + ".");
    if (flags.indexOf("RESEARCH_REQUIRED") !== -1) b.push("Research is required for this topic.");
    if (flags.indexOf("LANGUAGE_MISMATCH") !== -1) b.push("Language mismatch.");
    const snap = article.approved_snapshot || {};
    if (!String(snap.title || "").trim()) b.push("Title is missing.");
    if (!String(snap.content || "").trim()) b.push("Content is missing.");
    if (!SLUG_RE.test(String(snap.slug || ""))) b.push("Slug is missing or invalid.");
  }
  if (!website.publishing_enabled) b.push("Publishing is disabled for this website.");
  if (!website.publisher_type) b.push("No publisher is configured for this website.");
  if (!website.base_url) b.push("The website has no public base URL.");
  if (website.connection_status !== "connected") b.push("Publisher connection is not healthy (" + (website.connection_status || "not tested") + "). Run Test Connection.");
  if (!integration || integration.status !== "active") b.push("Publishing integration is not active.");
  else if (website.publisher_type !== "pocketbase_cms" && !integration.secret_last4) b.push("Publisher credentials are not configured.");
  if (integration && integration.publisher_type !== website.publisher_type) b.push("Integration publisher does not match the website configuration.");
  return b;
}

function slugConflict(article, website, slug) {
  const L = lib();
  const other = L.findFirst("article_publications", "website = {:w} && slug = {:s} && article != {:a} && status != 'unpublished'", "", { w: website.id, s: slug, a: article.id });
  if (other) return { article: other.article, public_url: other.public_url };
  const pc = L.findFirst("published_content", "website = {:w} && slug = {:s} && article != {:a}", "", { w: website.id, s: slug, a: article.id });
  if (pc) return { article: pc.article, public_url: "" };
  return null;
}

function publicUrlPreview(website, slug) {
  return String(website.base_url || "").replace(/\/+$/, "") + (website.blog_path || "") + "/" + slug;
}

// Confirmation data for the Publish dialog (no side effects).
function preview(actor, body) {
  const r = articleFor(actor, body.articleId, body.websiteId);
  const a = r.article;
  const w = r.website;
  const integration = integrationOf(w.id);
  const publication = publicationOf(a.id, w.id);
  const live = publication && (publication.status === "published" || publication.status === "verification_required");
  const operation = live ? "update" : (publication && publication.status === "unpublished" ? "republish" : "publish");
  const snap = a.approved_snapshot || snapshotOf(a);
  const blockers = blockersFor(a, w, integration, operation);
  const conflict = SLUG_RE.test(String(snap.slug || "")) ? slugConflict(a, w, String(snap.slug)) : null;
  if (conflict) blockers.push("SLUG_CONFLICT: another article already uses /" + snap.slug + " on this website.");
  if (live && Number(publication.article_version) === Number(a.approved_version) && publication.version_hash === a.approved_hash) blockers.push("This approved version is already live.");
  return {
    operation: operation,
    website: { id: w.id, name: w.name, domain: w.domain, environment: w.publishing_environment || "", publisher: w.publisher_type || "" },
    version: Number(a.approved_version || 0), current_version: Number(a.current_version || 0),
    title: String(snap.title || ""), slug: String(snap.slug || ""), content_type: a.content_type,
    url_preview: w.base_url ? publicUrlPreview(w, String(snap.slug || "")) : "",
    high_risk: Boolean(a.high_risk), blockers: blockers, slug_conflict: Boolean(conflict),
    publication: publication ? { id: publication.id, status: publication.status, version: publication.article_version, public_url: publication.public_url } : null,
  };
}

// (operation, article, website, version, hash, live-version hash, epoch):
// a double click maps to the same key; a genuinely new state gets a new one.
function idemKey(op, article, website, version, hash, seq, liveHash) {
  return [op, article, website, "v" + version, String(hash || "").slice(0, 16), "from" + String(liveHash || "none").slice(0, 16), "s" + seq].join(":");
}

function existingByKey(key) {
  return lib().findFirst("publish_jobs", "idempotency_key = {:k} && status != 'failed' && status != 'cancelled'", "", { k: key });
}

function requestPublish(actor, body) {
  const L = lib();
  assertPublisher(actor);
  if (body.confirm !== true) L.fail(400, "CONFIRMATION_REQUIRED", "Publishing requires explicit human confirmation.");
  const r = articleFor(actor, body.articleId, body.websiteId);
  const a = r.article;
  const w = r.website;
  const integration = integrationOf(w.id);
  const publication = publicationOf(a.id, w.id);
  const live = publication && (publication.status === "published" || publication.status === "verification_required");
  const wanted = String(body.operation || "");
  const operation = live ? "update" : (publication && publication.status === "unpublished" ? "republish" : "publish");
  if (wanted && wanted !== operation) L.fail(409, "INVALID_STATE", "Expected operation " + operation + " for the current publication state.");
  const seq = publication ? Number(publication.epoch || 0) : 0;
  const key = idemKey(operation, a.id, w.id, a.approved_version, a.approved_hash, seq, live ? publication.version_hash : "");
  const dup = existingByKey(key);
  if (dup) return { id: dup.id, status: dup.status, operation: dup.operation, created: false };
  const busy = activeJob(a.id);
  if (busy) L.fail(409, "BUSY", "A publishing job is already running for this article.");
  const blockers = blockersFor(a, w, integration, operation);
  if (blockers.length) L.fail(409, "NOT_PUBLISHABLE", blockers.join(" "));
  if (live && Number(publication.article_version) === Number(a.approved_version) && publication.version_hash === a.approved_hash) L.fail(409, "ALREADY_LIVE", "This approved version is already live.");
  const conflict = slugConflict(a, w, String(a.approved_snapshot.slug));
  if (conflict) L.fail(409, "SLUG_CONFLICT", "Another article already uses /" + a.approved_snapshot.slug + " on this website. Resolve the slug conflict first.");
  if (a.high_risk && body.acknowledgeHighRisk !== true) L.fail(409, "HIGH_RISK_REVIEW_REQUIRED", "High-risk content: confirm you reviewed the regulated claims before publishing.");
  let job = null;
  try {
    $app.runInTransaction(function (tx) {
      job = queueJob(tx, {
        organization: a.organization, client: a.client, website: w.id, article: a.id, publication: publication ? publication.id : "",
        operation: operation, publisher_type: w.publisher_type, article_version: Number(a.approved_version), version_hash: a.approved_hash,
        requested_by: actor.id, idempotency_key: key, acknowledge_high_risk: Boolean(a.high_risk && body.acknowledgeHighRisk === true),
      });
      L.updateRec("articles", a.id, { status: "publish_queued", updated_at: L.now() }, tx);
      L.articleActivity(tx, a, actor, "PUBLISH_REQUESTED", { job: job.id, operation: operation, version: Number(a.approved_version), publisher: w.publisher_type, environment: w.publishing_environment || "", url_preview: publicUrlPreview(w, String(a.approved_snapshot.slug)) });
    });
  } catch (err) {
    const winner = existingByKey(key) || activeJob(a.id);
    if (winner) return { id: winner.id, status: winner.status, operation: winner.operation, created: false };
    throw err;
  }
  return { id: job.id, status: job.status, operation: operation, created: true };
}

function livePublication(actor, body) {
  const L = lib();
  const r = articleFor(actor, body.articleId, body.websiteId);
  const publication = publicationOf(r.article.id, r.website.id);
  if (!publication) L.fail(409, "NOT_PUBLISHED", "This article has no publication on its website.");
  return { article: r.article, website: r.website, publication: publication };
}

function requestUnpublish(actor, body) {
  const L = lib();
  assertPublisher(actor);
  if (body.confirm !== true) L.fail(400, "CONFIRMATION_REQUIRED", "Unpublishing requires explicit confirmation.");
  const r = livePublication(actor, body);
  if (["published", "verification_required", "failed"].indexOf(r.publication.status) === -1) L.fail(409, "INVALID_STATE", "The publication is " + r.publication.status + ".");
  const key = ["unpublish", r.article.id, r.website.id, "s" + Number(r.publication.epoch || 0)].join(":");
  const dup = existingByKey(key);
  if (dup) return { id: dup.id, status: dup.status, operation: "unpublish", created: false };
  if (activeJob(r.article.id)) L.fail(409, "BUSY", "A publishing job is already running for this article.");
  let job = null;
  $app.runInTransaction(function (tx) {
    job = queueJob(tx, {
      organization: r.article.organization, client: r.article.client, website: r.website.id, article: r.article.id, publication: r.publication.id,
      operation: "unpublish", publisher_type: r.website.publisher_type, article_version: Number(r.publication.article_version || 0),
      version_hash: r.publication.version_hash, requested_by: actor.id, idempotency_key: key,
    });
    L.articleActivity(tx, r.article, actor, "UNPUBLISH_REQUESTED", { job: job.id, public_url: r.publication.public_url });
  });
  return { id: job.id, status: job.status, operation: "unpublish", created: true };
}

function requestVerify(actor, body) {
  const L = lib();
  assertPublisher(actor);
  const r = livePublication(actor, body);
  if (["published", "verification_required", "unpublished"].indexOf(r.publication.status) === -1) L.fail(409, "INVALID_STATE", "Nothing to verify.");
  const running = activeJob(r.article.id);
  if (running) return { id: running.id, status: running.status, operation: running.operation, created: false };
  let job = null;
  $app.runInTransaction(function (tx) {
    job = queueJob(tx, {
      organization: r.article.organization, client: r.article.client, website: r.website.id, article: r.article.id, publication: r.publication.id,
      operation: "verify", publisher_type: r.website.publisher_type, article_version: Number(r.publication.article_version || 0),
      version_hash: r.publication.version_hash, requested_by: actor.id, max_attempts: 1,
      idempotency_key: ["verify", r.article.id, r.website.id, $security.randomString(10)].join(":"),
    });
  });
  return { id: job.id, status: job.status, operation: "verify", created: true };
}

// Previously published versions available for rollback (from success events).
function publishedVersions(articleId) {
  const rows = lib().findMany("publication_events", "article = {:a} && status = 'success' && (operation = 'publish' || operation = 'update' || operation = 'republish' || operation = 'rollback')", "-created_at", 200, { a: articleId });
  const seen = {};
  const out = [];
  for (const e of rows) {
    const d = e.details || {};
    if (!d.snapshot || !d.hash || seen[d.hash]) continue;
    seen[d.hash] = true;
    out.push({ event: e.id, version: Number(e.version || 0), hash: d.hash, at: e.created_at, title: String(d.snapshot.title || "") });
  }
  return out;
}

function requestRollback(actor, body) {
  const L = lib();
  assertPublisher(actor);
  if (body.confirm !== true) L.fail(400, "CONFIRMATION_REQUIRED", "Rollback requires explicit confirmation.");
  const r = livePublication(actor, body);
  if (["published", "verification_required"].indexOf(r.publication.status) === -1) L.fail(409, "INVALID_STATE", "Only a live publication can be rolled back.");
  const event = L.getOne("publication_events", String(body.eventId || ""));
  if (!event || event.article !== r.article.id || event.organization !== actor.organization || event.status !== "success" || !(event.details && event.details.snapshot)) L.fail(404, "NOT_FOUND", "Previously published version not found.");
  const hash = String(event.details.hash || "");
  if (hash !== snapshotHash(event.details.snapshot)) L.fail(409, "INTEGRITY", "Stored snapshot failed its integrity check.");
  if (hash === r.publication.version_hash) L.fail(409, "ALREADY_LIVE", "That version is already live.");
  if (String(event.details.snapshot.slug) !== String(r.publication.slug)) L.fail(409, "SLUG_CHANGED", "Rollback to a version with a different slug would create another URL; not allowed.");
  const key = idemKey("rollback", r.article.id, r.website.id, event.version, hash, Number(r.publication.epoch || 0), r.publication.version_hash);
  const dup = existingByKey(key);
  if (dup) return { id: dup.id, status: dup.status, operation: "rollback", created: false };
  if (activeJob(r.article.id)) L.fail(409, "BUSY", "A publishing job is already running for this article.");
  const integration = integrationOf(r.website.id);
  const blockers = blockersFor(r.article, r.website, integration, "rollback");
  if (blockers.length) L.fail(409, "NOT_PUBLISHABLE", blockers.join(" "));
  let job = null;
  $app.runInTransaction(function (tx) {
    job = queueJob(tx, {
      organization: r.article.organization, client: r.article.client, website: r.website.id, article: r.article.id, publication: r.publication.id,
      operation: "rollback", publisher_type: r.website.publisher_type, article_version: Number(event.version), target_version: Number(event.version),
      version_hash: hash, requested_by: actor.id, idempotency_key: key, response_summary: { rollback_event: event.id },
    });
    L.articleActivity(tx, r.article, actor, "ROLLBACK_REQUESTED", { job: job.id, to_version: Number(event.version), from_version: Number(r.publication.article_version) });
  });
  return { id: job.id, status: job.status, operation: "rollback", created: true };
}

function cancelJob(actor, body) {
  const L = lib();
  assertPublisher(actor);
  const job = L.getOne("publish_jobs", String(body.jobId || ""));
  if (!job || job.organization !== actor.organization) L.fail(404, "NOT_FOUND", "Job not found.");
  if (job.status !== "queued") L.fail(409, "INVALID_STATE", "Only queued jobs can be cancelled.");
  $app.runInTransaction(function (tx) {
    L.updateRec("publish_jobs", job.id, { status: "cancelled", completed_at: L.now(), updated_at: L.now() }, tx);
    if (job.article && ["publish", "update", "republish"].indexOf(job.operation) !== -1) {
      const a = L.getOne("articles", job.article, tx);
      if (a && a.status === "publish_queued") L.updateRec("articles", a.id, { status: "approved", updated_at: L.now() }, tx);
    }
  });
  return { ok: true };
}

module.exports = {
  PUBLISHER_TYPES, SNAPSHOT_FIELDS, stableStringify, snapshotOf, snapshotHash,
  saveConfig, saveSecret, testConnection, preview, requestPublish, requestUnpublish, requestVerify, requestRollback, cancelJob, publishedVersions,
  activeJob,
};
