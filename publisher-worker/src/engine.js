// bunker-seo-publisher engine: claim → validate → adapter → verify → persist.
// Runs with PocketBase superuser credentials in the worker process only.
import { createAdapter } from "./adapters/index.js";
import { PublishError } from "./net.js";
import { snapshotHash, snapshotOf } from "./content.js";
import { secretsOf } from "./secrets.js";

export const WORKER_VERSION = "publisher-0.5.0";
const esc = (v) => String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const nowIso = () => new Date().toISOString();
const CONTENT_OPS = ["publish", "update", "republish", "rollback"];
export const BACKOFF_MS = [30_000, 120_000, 480_000];

async function one(pb, col, id) {
  if (!id) return null;
  try { return await pb.collection(col).getOne(id); } catch (e) { if (e?.status === 404) return null; throw e; }
}

/** Atomically-enough claim: status guard + unique active-article index prevent double processing. */
export async function claimNextJob(pb, now = new Date(), scope = "") {
  const due = `status = "queued" && (next_attempt_at = "" || next_attempt_at <= "${now.toISOString().replace("T", " ")}")`;
  const list = await pb.collection("publish_jobs").getList(1, 10, { filter: scope ? `${due} && (${scope})` : due, sort: "created_at" });
  for (const c of list.items) {
    const fresh = await one(pb, "publish_jobs", c.id);
    if (!fresh || fresh.status !== "queued") continue;
    try {
      return await pb.collection("publish_jobs").update(c.id, { status: "validating", attempt: Number(fresh.attempt || 0) + 1, started_at: fresh.started_at || nowIso(), error_code: "", error_message: "", updated_at: nowIso() });
    } catch (e) {
      if ([400, 404, 409].includes(e?.status)) continue;
      throw e;
    }
  }
  return null;
}

function safeMessage(err) {
  const msg = String(err?.message || "Unexpected error").replace(/(authorization|password|secret|token|bearer)[^,;]*/gi, "$1 [redacted]");
  return msg.slice(0, 500);
}

async function activity(pb, job, action, metadata) {
  await pb.collection("activity_logs").create({ organization: job.organization, client: job.client, website: job.website, user: job.requested_by || "", action, entity_type: job.article ? "article" : "website", entity_id: job.article || job.website, metadata: { job: job.id, ...metadata }, created_at: nowIso() });
}

async function event(pb, job, publication, fields) {
  return pb.collection("publication_events").create({ organization: job.organization, client: job.client, website: job.website, publication: publication?.id || "", article: job.article, job: job.id, actor: job.requested_by || "", created_at: nowIso(), ...fields });
}

/** Load and cross-check every tenant relation of the job (defense in depth). */
export async function loadContext(pb, job, { env, key }) {
  const website = await one(pb, "websites", job.website);
  if (!website) throw new PublishError("NOT_FOUND", "Website not found");
  const client = await one(pb, "clients", website.client);
  if (!client || client.organization !== website.organization) throw new PublishError("TENANT_MISMATCH", "Website/client relationship is inconsistent");
  if (job.organization !== website.organization || job.client !== website.client) throw new PublishError("TENANT_MISMATCH", "Job tenant does not match the website");
  const integration = (await pb.collection("integrations").getList(1, 1, { filter: `website = "${esc(website.id)}" && kind = "publishing"` })).items[0];
  if (!integration) throw new PublishError("NOT_CONFIGURED", "No publishing integration for this website");
  if (integration.organization !== website.organization || integration.client !== website.client) throw new PublishError("TENANT_MISMATCH", "Integration does not belong to this website's tenant");
  if (integration.publisher_type !== website.publisher_type || (job.publisher_type && job.publisher_type !== website.publisher_type)) throw new PublishError("CONFIG_MISMATCH", "Publisher configuration changed since the job was queued");
  let article = null;
  if (job.article) {
    article = await one(pb, "articles", job.article);
    if (!article) throw new PublishError("NOT_FOUND", "Article not found");
    if (article.organization !== job.organization || article.client !== job.client || article.website !== job.website) throw new PublishError("TENANT_MISMATCH", "Article does not belong to the job's website");
  }
  let publication = job.publication ? await one(pb, "article_publications", job.publication) : null;
  if (!publication && article) publication = (await pb.collection("article_publications").getList(1, 1, { filter: `article = "${esc(article.id)}" && website = "${esc(website.id)}"` })).items[0] || null;
  if (publication && (publication.website !== website.id || publication.article !== job.article)) throw new PublishError("TENANT_MISMATCH", "Publication does not match the job");
  // The raw hidden secret fields are only readable by the superuser worker.
  const secrets = key ? secretsOf(integration, key) : [];
  return { website, client, integration, article, publication, secrets, env, job };
}

/** Pre-publish lock check: the snapshot being sent is exactly the approved one. */
export function lockedSnapshot(job, article, rollbackSnapshot) {
  if (job.operation === "rollback") {
    if (!rollbackSnapshot) throw new PublishError("NOT_FOUND", "Rollback snapshot not found");
    if (snapshotHash(rollbackSnapshot) !== job.version_hash) throw new PublishError("INTEGRITY", "Rollback snapshot failed its integrity check");
    return rollbackSnapshot;
  }
  if (!["approved", "publish_queued", "publishing", "publish_failed"].includes(article.status)) throw new PublishError("NOT_APPROVED", `Article is ${article.status}`);
  if (!article.approved_by || !article.approved_at || !article.approved_snapshot || !article.approved_hash) throw new PublishError("NOT_APPROVED", "No recorded human approval");
  if (article.approved_hash !== job.version_hash || Number(article.approved_version) !== Number(job.article_version)) throw new PublishError("REAPPROVAL_REQUIRED", "The approved version changed after the job was queued");
  if (snapshotHash(article.approved_snapshot) !== article.approved_hash) throw new PublishError("INTEGRITY", "Approved snapshot failed its integrity check");
  if (Number(article.current_version) !== Number(article.approved_version) || snapshotHash(snapshotOf(article)) !== article.approved_hash) throw new PublishError("REAPPROVAL_REQUIRED", "Content changed after approval; re-approval required");
  if (article.fact_check_status !== "passed") throw new PublishError("NOT_APPROVED", "Fact check has not passed");
  if (article.high_risk && !job.acknowledge_high_risk) throw new PublishError("HIGH_RISK_REVIEW_REQUIRED", "High-risk content requires acknowledgement");
  return article.approved_snapshot;
}

async function ensurePublication(pb, job, ctx, snapshot) {
  if (ctx.publication) return ctx.publication;
  const ts = nowIso();
  try {
    return await pb.collection("article_publications").create({ organization: job.organization, client: job.client, website: job.website, article: job.article, article_version: snapshot.version, version_hash: job.version_hash, publisher_type: ctx.website.publisher_type, slug: snapshot.slug, status: "publishing", epoch: 0, metadata: {}, created_at: ts, updated_at: ts });
  } catch (e) {
    // Unique (article, website): a concurrent creator won — reuse it, never duplicate.
    const found = (await pb.collection("article_publications").getList(1, 1, { filter: `article = "${esc(job.article)}" && website = "${esc(job.website)}"` })).items[0];
    if (found) return found;
    throw e;
  }
}

async function slugGuard(pb, ctx, snapshot, publication) {
  const other = await pb.collection("article_publications").getList(1, 1, { filter: `website = "${esc(ctx.website.id)}" && slug = "${esc(snapshot.slug)}" && id != "${esc(publication.id)}" && status != "unpublished"` });
  if (other.totalItems) throw new PublishError("SLUG_CONFLICT", "Another article already uses this slug on the website");
  if (publication.slug && publication.slug !== snapshot.slug && ["published", "verification_required"].includes(publication.status)) throw new PublishError("SLUG_CHANGED", "Changing the slug of a live publication would create another URL; unpublish first");
}

const setJob = (pb, job, fields) => pb.collection("publish_jobs").update(job.id, { ...fields, updated_at: nowIso() });
const setArticle = (pb, id, fields) => pb.collection("articles").update(id, { ...fields, updated_at: nowIso() });

async function runContentOp(pb, job, ctx, adapter, logger) {
  let rollbackSnapshot = null;
  if (job.operation === "rollback") {
    const ev = await one(pb, "publication_events", job.response_summary?.rollback_event);
    if (!ev || ev.article !== job.article || ev.status !== "success") throw new PublishError("NOT_FOUND", "Rollback source event not found");
    rollbackSnapshot = ev.details?.snapshot;
  }
  const snapshot = lockedSnapshot(job, ctx.article, rollbackSnapshot);
  const publication = await ensurePublication(pb, job, ctx, snapshot);
  ctx.publication = publication;
  await slugGuard(pb, ctx, snapshot, publication);
  await setJob(pb, job, { status: "publishing", publication: publication.id });
  if (job.operation !== "rollback") await setArticle(pb, job.article, { status: "publishing" });
  const live = ["published", "verification_required"].includes(publication.status) && publication.remote_id;
  logger.log(`[publisher] job=${job.id} website=${job.website} adapter=${adapter.name} op=${job.operation} step=send`);
  const result = live ? await adapter.update(snapshot, ctx, job.version_hash) : await adapter.publish(snapshot, ctx, job.version_hash);
  const ts = nowIso();
  // Record acceptance BEFORE verification so a failed verify never leads to a second publish.
  await pb.collection("article_publications").update(publication.id, { remote_id: result.remoteId, public_url: result.publicUrl, slug: snapshot.slug, publisher_type: adapter.name, updated_at: ts, metadata: { ...(publication.metadata || {}), last_accepted: { job: job.id, operation: job.operation, version: snapshot.version, hash: job.version_hash, at: ts, snapshot } } });
  await setJob(pb, job, { status: "verifying", remote_id: result.remoteId, public_url: result.publicUrl, response_summary: { ...(job.response_summary || {}), accepted: result.response } });
  return verifyAndPersist(pb, job, ctx, adapter, { snapshot, publication: { ...publication, remote_id: result.remoteId, public_url: result.publicUrl, slug: snapshot.slug }, logger });
}

async function verifyAndPersist(pb, job, ctx, adapter, { snapshot, publication, logger }) {
  ctx.publication = publication;
  const url = publication.public_url;
  const v = await adapter.verify(ctx, { expect: "live", hash: job.version_hash, url, slug: snapshot.slug, title: snapshot.title });
  const ts = nowIso();
  const op = job.operation;
  if (!v.ok) {
    await pb.collection("article_publications").update(publication.id, { status: "verification_required", updated_at: ts });
    await setJob(pb, job, { status: "verification_required", completed_at: ts, error_code: "VERIFICATION_FAILED", error_message: String(v.reason || "Verification failed").slice(0, 500), response_summary: { ...(job.response_summary || {}), verification: v.checks } });
    if (op !== "rollback") await setArticle(pb, job.article, { status: "publish_failed" });
    await event(pb, job, publication, { version: snapshot.version, operation: op === "rollback" ? "rollback" : op, status: "verification_required", remote_id: publication.remote_id, public_url: url, details: { reason: v.reason, checks: v.checks } });
    await activity(pb, job, "PUBLISH_FAILED", { operation: op, error_code: "VERIFICATION_FAILED", reason: v.reason, public_url: url });
    logger.warn(`[publisher] job=${job.id} op=${op} status=verification_required`);
    return { status: "verification_required" };
  }
  const firstPublish = !publication.published_at || publication.status === "unpublished";
  await pb.collection("article_publications").update(publication.id, {
    status: "published", article_version: snapshot.version, version_hash: job.version_hash, public_url: url, slug: snapshot.slug,
    published_at: firstPublish ? ts : publication.published_at, published_by: firstPublish ? job.requested_by : publication.published_by, last_verified_at: ts, updated_at: ts,
  });
  await setJob(pb, job, { status: "published", completed_at: ts, response_summary: { ...(job.response_summary || {}), verification: v.checks } });
  const article = await one(pb, "articles", job.article);
  const articleFields = { published_version: snapshot.version };
  if (!article.published_at || firstPublish) articleFields.published_at = ts;
  // Article status mirrors the publication only while it is in the publish flow;
  // a newer draft/approval in progress is left untouched.
  if (["publish_queued", "publishing", "publish_failed", "approved", "unpublished"].includes(article.status) && (op !== "rollback" || article.status !== "approved")) articleFields.status = "published";
  await setArticle(pb, job.article, articleFields);
  await pb.collection("websites").update(job.website, { last_publication_at: ts });
  const evOp = op === "verify" ? "verify" : op;
  await event(pb, job, publication, { version: snapshot.version, operation: evOp, status: "success", remote_id: publication.remote_id, public_url: url, details: { snapshot, hash: job.version_hash, checks: v.checks } });
  const action = { publish: "ARTICLE_PUBLISHED", republish: "ARTICLE_PUBLISHED", update: "PUBLICATION_UPDATED", rollback: "PUBLICATION_ROLLED_BACK", verify: "PUBLICATION_VERIFIED" }[op];
  await activity(pb, job, action, { operation: op, version: snapshot.version, public_url: url });
  logger.log(`[publisher] job=${job.id} op=${op} status=published`);
  return { status: "published", public_url: url };
}

async function runVerify(pb, job, ctx, adapter, logger) {
  const pub = ctx.publication;
  if (!pub) throw new PublishError("NOT_FOUND", "Nothing to verify");
  if (pub.status === "unpublished") {
    const v = await adapter.verify(ctx, { expect: "gone", url: pub.public_url, slug: pub.slug });
    const ts = nowIso();
    await setJob(pb, job, { status: v.ok ? "unpublished" : "verification_required", completed_at: ts, response_summary: { verification: v.checks }, error_message: v.ok ? "" : String(v.reason || "").slice(0, 500) });
    await event(pb, job, pub, { version: pub.article_version, operation: "verify", status: v.ok ? "success" : "verification_required", public_url: pub.public_url, details: { expect: "gone", checks: v.checks } });
    return { status: v.ok ? "unpublished" : "verification_required" };
  }
  // Verify Again after a partial failure checks the version the target ACCEPTED
  // (never re-sends it); otherwise it re-checks the version recorded as live.
  const pending = pub.status === "verification_required" ? pub.metadata?.last_accepted : null;
  let hash = pending?.hash || pub.version_hash;
  let snap = pending?.snapshot || null;
  if (!snap) {
    const events = await pb.collection("publication_events").getList(1, 50, { filter: `publication = "${esc(pub.id)}" && status = "success"`, sort: "-created_at" });
    snap = events.items.find((e) => e.details?.hash === hash)?.details?.snapshot || (ctx.article?.approved_hash === hash ? ctx.article.approved_snapshot : null);
  }
  if (!snap || snapshotHash(snap) !== hash) throw new PublishError("NOT_FOUND", "The published version snapshot is not available");
  const op = pending?.operation && pending.operation !== "verify" ? pending.operation : "verify";
  return verifyAndPersist(pb, { ...job, version_hash: hash, operation: op === "verify" ? "verify" : op }, ctx, adapter, { snapshot: snap, publication: pub, logger });
}

async function runUnpublish(pb, job, ctx, adapter, logger) {
  const pub = ctx.publication;
  if (!pub) throw new PublishError("NOT_FOUND", "No publication");
  await setJob(pb, job, { status: "unpublishing" });
  logger.log(`[publisher] job=${job.id} website=${job.website} adapter=${adapter.name} op=unpublish step=send`);
  await adapter.unpublish(ctx);
  const v = await adapter.verify(ctx, { expect: "gone", url: pub.public_url, slug: pub.slug });
  const ts = nowIso();
  if (!v.ok) {
    await pb.collection("article_publications").update(pub.id, { status: "verification_required", updated_at: ts });
    await setJob(pb, job, { status: "verification_required", completed_at: ts, error_code: "VERIFICATION_FAILED", error_message: String(v.reason).slice(0, 500), response_summary: { verification: v.checks } });
    await event(pb, job, pub, { version: pub.article_version, operation: "unpublish", status: "verification_required", public_url: pub.public_url, details: { reason: v.reason, checks: v.checks } });
    await activity(pb, job, "PUBLISH_FAILED", { operation: "unpublish", error_code: "VERIFICATION_FAILED", reason: v.reason });
    return { status: "verification_required" };
  }
  await pb.collection("article_publications").update(pub.id, { status: "unpublished", unpublished_at: ts, epoch: Number(pub.epoch || 0) + 1, last_verified_at: ts, updated_at: ts });
  await setJob(pb, job, { status: "unpublished", completed_at: ts, response_summary: { verification: v.checks } });
  const article = await one(pb, "articles", job.article);
  if (article && ["published", "publish_failed"].includes(article.status)) await setArticle(pb, job.article, { status: "unpublished" });
  await event(pb, job, pub, { version: pub.article_version, operation: "unpublish", status: "success", remote_id: pub.remote_id, public_url: pub.public_url, details: { checks: v.checks } });
  await activity(pb, job, "ARTICLE_UNPUBLISHED", { public_url: pub.public_url, version: pub.article_version });
  logger.log(`[publisher] job=${job.id} op=unpublish status=unpublished`);
  return { status: "unpublished" };
}

async function runTest(pb, job, ctx, adapter) {
  const ts = nowIso();
  try {
    await adapter.testConnection(ctx);
    await pb.collection("websites").update(job.website, { connection_status: "connected", last_connection_test: ts, last_connection_error: "" });
    await setJob(pb, job, { status: "completed", completed_at: ts, response_summary: { result: "connected" } });
    await activity(pb, job, "PUBLISHING_CONNECTION_TESTED", { result: "connected" });
    return { status: "completed" };
  } catch (e) {
    const code = e?.code || "FAILED";
    const status = { UNAUTHORIZED: "unauthorized", INVALID_RESPONSE: "invalid_response", TIMEOUT: "timeout" }[code] || "failed";
    await pb.collection("websites").update(job.website, { connection_status: status, last_connection_test: ts, last_connection_error: `${code}: ${safeMessage(e)}`.slice(0, 500) });
    await setJob(pb, job, { status: "failed", completed_at: ts, error_code: code, error_message: safeMessage(e), response_summary: { result: status } });
    await activity(pb, job, "PUBLISHING_CONNECTION_TESTED", { result: status, error_code: code });
    return { status: "failed", connection: status };
  }
}

/** Process one claimed job. Retries (max_attempts, backoff) only for retryable pre-acceptance failures. */
export async function processJob(pb, job, { env = process.env, key, logger = console, adapterFor } = {}) {
  let ctx;
  try {
    ctx = await loadContext(pb, job, { env, key });
    const adapter = adapterFor ? adapterFor(ctx.website.publisher_type, ctx) : createAdapter(ctx.website.publisher_type, { pb, env });
    logger.log(`[publisher] job=${job.id} website=${job.website} adapter=${adapter.name} op=${job.operation} status=validating attempt=${job.attempt}`);
    if (job.operation === "test_connection") return await runTest(pb, job, ctx, adapter);
    if (!ctx.website.publishing_enabled) throw new PublishError("PUBLISHING_DISABLED", "Publishing is disabled for this website");
    if (job.operation === "unpublish") return await runUnpublish(pb, job, ctx, adapter, logger);
    if (job.operation === "verify") return await runVerify(pb, job, ctx, adapter, logger);
    if (CONTENT_OPS.includes(job.operation)) return await runContentOp(pb, job, ctx, adapter, logger);
    throw new PublishError("INVALID", `Unknown operation ${job.operation}`);
  } catch (err) {
    return fail(pb, job, ctx, err, logger);
  }
}

async function fail(pb, job, ctx, err, logger) {
  const code = err?.code && /^[A-Z_]+$/.test(err.code) ? err.code : "PUBLISH_ERROR";
  const message = safeMessage(err);
  const fresh = await one(pb, "publish_jobs", job.id);
  // Once the target accepted the content (status verifying), never re-send automatically.
  const accepted = fresh?.status === "verifying";
  const attempt = Number(fresh?.attempt || job.attempt || 1);
  const max = Number(fresh?.max_attempts || 3);
  const ts = nowIso();
  if (accepted) {
    if (fresh.publication) await pb.collection("article_publications").update(fresh.publication, { status: "verification_required", updated_at: ts }).catch(() => {});
    await setJob(pb, job, { status: "verification_required", completed_at: ts, error_code: code, error_message: message });
    if (job.article && job.operation !== "rollback") await setArticle(pb, job.article, { status: "publish_failed" }).catch(() => {});
    await activity(pb, job, "PUBLISH_FAILED", { operation: job.operation, error_code: code, stage: "verify" }).catch(() => {});
    logger.warn(`[publisher] job=${job.id} op=${job.operation} status=verification_required code=${code}`);
    return { status: "verification_required", code };
  }
  if (err?.retryable && attempt < max) {
    const delay = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
    await setJob(pb, job, { status: "queued", next_attempt_at: new Date(Date.now() + delay).toISOString(), error_code: code, error_message: message });
    logger.warn(`[publisher] job=${job.id} op=${job.operation} status=retry attempt=${attempt}/${max} code=${code} backoff_ms=${delay}`);
    return { status: "queued", retry: true, code };
  }
  await setJob(pb, job, { status: "failed", completed_at: ts, error_code: code, error_message: message });
  if (job.operation === "test_connection") return { status: "failed", code };
  if (job.article) {
    const a = await one(pb, "articles", job.article);
    if (a && ["publish_queued", "publishing"].includes(a.status)) {
      const pub = ctx?.publication || (fresh?.publication ? await one(pb, "article_publications", fresh.publication) : null);
      // An update/rollback that fails leaves the previous version live.
      const live = pub && pub.status === "published";
      await setArticle(pb, job.article, { status: live && job.operation !== "publish" ? "published" : "publish_failed" });
    }
    const pub = fresh?.publication ? await one(pb, "article_publications", fresh.publication) : null;
    if (pub && pub.status === "publishing") await pb.collection("article_publications").update(pub.id, { status: "failed", updated_at: ts }).catch(() => {});
    await event(pb, job, pub, { version: Number(job.article_version || 0), operation: ["publish", "update", "republish", "rollback", "unpublish", "verify"].includes(job.operation) ? job.operation : "publish", status: "failed", details: { error_code: code, error_message: message } }).catch(() => {});
  }
  await activity(pb, job, "PUBLISH_FAILED", { operation: job.operation, error_code: code, message }).catch(() => {});
  logger.warn(`[publisher] job=${job.id} op=${job.operation} status=failed code=${code}`);
  return { status: "failed", code };
}

/** Jobs stuck mid-flight after a crash: pre-acceptance → retry; post-acceptance → verification_required. */
export async function recoverStale(pb, { staleMs = 15 * 60_000, logger = console } = {}) {
  const rows = await pb.collection("publish_jobs").getFullList({ filter: 'status = "validating" || status = "publishing" || status = "verifying" || status = "unpublishing"' });
  let n = 0;
  for (const j of rows) {
    if (Date.now() - (Date.parse(j.updated_at || j.updated) || 0) < staleMs) continue;
    if (j.status === "verifying" || j.status === "unpublishing") await setJob(pb, j, { status: "verification_required", error_code: "WORKER_RESTART", error_message: "Worker restarted; use Verify Again." });
    else await setJob(pb, j, { status: "queued", next_attempt_at: nowIso(), error_code: "WORKER_RESTART", error_message: "Worker restarted before sending; retrying." });
    n++;
  }
  if (n) logger.warn(`[publisher] recovered ${n} stale job(s)`);
  return n;
}
