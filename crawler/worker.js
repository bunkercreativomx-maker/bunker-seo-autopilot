// Bunker SEO Autopilot — crawler worker entry point.
// Polls PocketBase for queued crawl jobs, processes them end to end
// (ownership validation -> robots -> sitemap -> BFS crawl -> SEO extract ->
// issue engine -> persistence -> snapshot -> change detection), updating job
// progress as it goes. Authenticates as the PocketBase superuser (server-side).
//
// Env:
//   PB_URL, PB_ADMIN_EMAIL, PB_ADMIN_PASSWORD
//   POLL_INTERVAL_MS (default 3000), MAX_PAGES, CONCURRENCY
import { runCrawl } from "./src/crawler.js";
import { createWorkerClient, authWorker, claimNextJob, resolveJobContext, getExistingPages, getExistingIssues, upsertPage, persistLinks, createSnapshot, updateJobProgress } from "./src/pb.js";
import { normalizeUrl } from "./src/normalize.js";
import { pageIssues } from "./src/issues.js";
import { applyAutoSetup } from "./src/autosetup.js";

const PB_URL = process.env.PB_URL || "http://127.0.0.1:8096";
const PB_ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL;
const PB_ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;
if (!PB_ADMIN_EMAIL || !PB_ADMIN_PASSWORD) {
  console.error("FATAL: PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD required");
  process.exit(1);
}
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || "3000", 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || "500", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "3", 10);
// Auto-setup (learn the business from its own site). The AI part is optional:
// without a key only deterministic facts (tel/mailto/language) are captured.
const AUTO_SETUP_AI = process.env.OPENAI_API_KEY
  ? { apiKey: process.env.OPENAI_API_KEY, baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1", model: process.env.AUTO_SETUP_MODEL || "gpt-5-mini" }
  : null;
const AUTO_SETUP_RENDER = process.env.FIRECRAWL_API_KEY
  ? { apiKey: process.env.FIRECRAWL_API_KEY, baseUrl: process.env.FIRECRAWL_BASE_URL || "https://api.firecrawl.dev/v1" }
  : null;

const client = createWorkerClient({ url: PB_URL });

let terminating = false;
process.on("SIGINT", () => { terminating = true; console.log("SIGINT, finishing..."); });
process.on("SIGTERM", () => { terminating = true; console.log("SIGTERM, finishing..."); });

async function processJob(job) {
  const jobId = job.id;

  // 1) ownership + relationship consistency
  await updateJobProgress(client, jobId, { pages_discovered: 0, pages_crawled: 0, errors_count: 0 });
  const ctxRes = await resolveJobContext(client, job);
  if (!ctxRes.ok) {
    await updateJobProgress(client, jobId, { status: "failed", error_message: ctxRes.error, completed_at: new Date().toISOString() });
    console.error(`[job ${jobId}] ownership rejected: ${ctxRes.error}`);
    return;
  }
  const ctx = { ...ctxRes, existingPages: new Map(), oldPages: {}, job };

  // load existing pages for change detection + upsert
  const existing = await getExistingPages(client, ctx.website.id);
  ctx.existingPages = new Map(existing.map((p) => [p.normalized_url || p.url, p]));
  ctx.oldPages = Object.fromEntries([...ctx.existingPages.entries()]);

  // 2) run crawl
  console.log(`[job ${jobId}] crawl start: ${ctx.website.domain}`);
  const result = await runCrawl(ctx.website.domain, { maxPages: MAX_PAGES, concurrency: CONCURRENCY });

  if (!result.success) {
    await updateJobProgress(client, jobId, { status: "failed", error_message: result.error, completed_at: new Date().toISOString() });
    console.error(`[job ${jobId}] crawl failed: ${result.error}`);
    return;
  }

  // 3) persist pages (upsert), record change detections
  const pageIdByUrl = new Map();
  const changes = [];
  for (const page of result.pages) {
    const up = await upsertPage(client, page, ctx);
    pageIdByUrl.set(normalizeUrl(page.url), up.id);
    if (up.changed) {
      const old = ctx.oldPages[normalizeUrl(page.url)];
      if (old && up.changed !== true) {
        for (const [field, diff] of Object.entries(up.changed)) {
          changes.push({
            organization: ctx.org.id, client: ctx.client.id, website: ctx.website.id,
            page: up.id, change_type: changeTypeFor(field), old_value: String(diff.old ?? ""), new_value: String(diff.new ?? ""),
            detected_at: new Date().toISOString(), crawl_job: jobId,
          });
        }
      } else if (!old) {
        changes.push({
          organization: ctx.org.id, client: ctx.client.id, website: ctx.website.id,
          page: up.id, change_type: "new_page", old_value: "", new_value: page.url,
          detected_at: new Date().toISOString(), crawl_job: jobId,
        });
      }
    }
  }
  for (const ch of changes) {
    try { await client.collection("website_changes").create(ch); } catch {}
  }

  // persist failed pages (they were already upserted as error pages above)
  const allPages = await getExistingPages(client, ctx.website.id);

  // 4) persist internal links (page_links) — after page ids known
  // Note: runCrawl returns raw link records w/o source_page_id; resolve here.
  const linkSourceQuery = new Map(); // source_url -> pageId
  for (const p of allPages) linkSourceQuery.set(p.normalized_url || p.url, p.id);
  const linkRecordLimit = 5000;
  let linksSaved = 0;
  for (const link of result.links) {
    if (linksSaved >= linkRecordLimit) break;
    if (link.link_type !== "internal") continue;
    const srcId = pageIdByUrl.get(normalizeUrl(link.source_url)) || linkSourceQuery.get(normalizeUrl(link.source_url));
    if (!srcId) continue;
    await persistLinks(client, srcId, [link], ctx, {});
    linksSaved++;
  }

  // 5) resolve link status codes for broken-internal-link detection.
  //    For each internal link where destination was crawled, read its status.
  for (const link of result.links) {
    if (link.link_type !== "internal") continue;
    const destPage = ctx.existingPages.get(normalizeUrl(link.destination_url));
    if (destPage && destPage.status_code >= 400) {
      // record broken link (issue handled in cross-page issues but persisted links
      // carry status_code); we updated in persistLinks with null, so patch here.
      const linkRec = await findLinkRecord(client, ctx.website.id, link.source_url, link.destination_url);
      if (linkRec) {
        await client.collection("page_links").update(linkRec.id, { status_code: destPage.status_code });
      }
    }
  }

  // 6) issue engine: per-page + cross-page, with dedup against existing
  await persistIssues(client, ctx, jobId, result, allPages, pageIdByUrl);

  // 7) snapshot summary
  const issueCounts = await countIssues(client, ctx.website.id);
  await createSnapshot(client, ctx, jobId, result.counts, issueCounts);

  // 8) mark completed / completed_with_errors
  const withErrors = result.failed.length > 0 || issueCounts.critical > 0;
  await updateJobProgress(client, jobId, {
    status: withErrors ? "completed_with_errors" : "completed",
    completed_at: new Date().toISOString(),
    pages_discovered: result.pages.length,
    pages_crawled: result.pages.filter((p) => p.status_code < 400).length,
    pages_failed: result.pages.filter((p) => p.status_code >= 400).length,
    errors_count: result.failed.length,
  });
  console.log(`[job ${jobId}] done: ${result.pages.length} pages, ${result.links.length} links, ${issueCounts.total} issues`);

  // 9) one-step setup: learn the business + language from the site, then queue topics.
  if (job.configuration && job.configuration.auto_setup === true) {
    try {
      await applyAutoSetup(client, ctx, job, result.pages, { ai: AUTO_SETUP_AI, render: AUTO_SETUP_RENDER });
    } catch (e) {
      console.error(`[job ${jobId}] auto-setup failed: ${e?.message || e}`);
    }
  }
}

async function persistIssues(client, ctx, jobId, result, allPages, pageIdByUrl) {
  const byKey = new Map();
  const add = (issue) => {
    if (!issue.issue_type) return;
    const key = `${issue.issue_type}::${issue.url || issue.source_url || issue.destination_url || issue.evidence?.title || ""}`;
    byKey.set(key, issue);
  };
  // per-page issues
  for (const page of allPages) {
    const fetchInfo = { statusCode: page.status_code, error: null };
    const pageIssueInput = {
      title: page.title || "", title_length: page.title_length || 0,
      meta_description: page.meta_description || "", meta_description_length: page.meta_description_length || 0,
      canonical_url: page.canonical_url || "", h1_count: page.h1_count || 0, h1: page.h1 || "",
      word_count: page.word_count || 0, images_count: page.images_count || 0, images_missing_alt: page.images_missing_alt || 0,
      invalid_schema: false, schema_types: page.schema_types || [], indexable: page.indexable, indexability_reason: page.indexability_reason,
      robots_directives: page.robots_directives || [], isHtml: true, html: " ",
    };
    const subs = pageIssues(pageIssueInput, fetchInfo);
    for (const s of subs) add({ ...s, url: page.url, page_id: page.id });
    // fetch_error note from page-level
    if (page.status_code === 0) {
      add({ issue_type: "fetch_error", severity: "high", category: "technical", title: "Page failed to fetch", description: "Could not retrieve this page.", evidence: { url: page.url }, recommended_action: "Check reachability.", url: page.url, page_id: page.id });
    }
  }
  // cross-page (duplicates, orphans, broken links)
  for (const c of (result.crossIssues || [])) {
    if (c.issue_type === "broken_internal_link" || c.issue_type === "potential_orphan_page") {
      add({ ...c });
    } else {
      // duplicate title / meta -> attach to each affected page
      for (const u of c.pages || []) {
        const pid = pageIdByUrl.get(normalizeUrl(u)) || allPages.find((p) => p.url === u)?.id;
        if (pid) add({ ...c });
      }
      // also add once as a website-level issue
      add({ ...c });
    }
  }

  // dedup against existing open issues (update last_detected_at; resolve ones no longer present)
  const existing = await getExistingIssues(client, ctx.website.id);
  const existingByKey = new Map();
  for (const e of existing) {
    const k = `${e.issue_type}::${e.evidence?.url || e.evidence?.source_url || e.evidence?.destination_url || e.evidence?.title || e.url || ""}`;
    existingByKey.set(k, e);
  }

  let written = 0;
  for (const [key, issue] of byKey) {
    const base = {
      organization: ctx.org.id, client: ctx.client.id, website: ctx.website.id,
      category: issue.category || "general", severity: issue.severity || "medium",
      issue_type: issue.issue_type, title: issue.title || issue.issue_type, description: issue.description || "",
      evidence: issue.evidence || {}, recommended_action: issue.recommended_action || "",
      status: "open", first_detected_at: new Date().toISOString(), last_detected_at: new Date().toISOString(),
    };
    const existingIssue = existingByKey.get(key);
    if (existingIssue && existingIssue.status === "open") {
      // refresh last_detected (keep first_detected & page)
      await client.collection("seo_issues").update(existingIssue.id, { last_detected_at: new Date().toISOString() });
      if (issue.page_id) await client.collection("seo_issues").update(existingIssue.id, { page: issue.page_id }).catch(() => {});
    } else if (!existingIssue) {
      await client.collection("seo_issues").create({ ...base, page: issue.page_id || undefined }).catch(() => {});
      written++;
    }
  }

  // resolve previously-open issues that no longer exist
  const activeKeys = new Set(byKey.keys());
  for (const e of existing) {
    if (e.status !== "open") continue;
    const k = `${e.issue_type}::${e.evidence?.url || e.evidence?.source_url || e.evidence?.destination_url || e.evidence?.title || e.url || ""}`;
    if (!activeKeys.has(k)) {
      await client.collection("seo_issues").update(e.id, { status: "resolved", resolved_at: new Date().toISOString() }).catch(() => {});
    }
  }
  return written;
}

async function findLinkRecord(pb, websiteId, srcUrl, destUrl) {
  // find a page_links record from this source to this destination
  try {
    const list = await pb.collection("page_links").getList(1, 5000, { filter: `destination_url = "${destUrl}"` });
    const destNorm = normalizeUrl(destUrl);
    for (const l of list.items) {
      if (normalizeUrl(l.destination_url) === (destNorm || destUrl)) return l;
    }
  } catch {}
  return null;
}

async function countIssues(pb, websiteId) {
  const all = await getExistingIssues(pb, websiteId);
  const open = all.filter((i) => i.status === "open");
  const bySev = { total: open.length, critical: 0, high: 0, medium: 0, low: 0, opportunity: 0 };
  for (const i of open) bySev[i.severity] = (bySev[i.severity] || 0) + 1;
  return bySev;
}

function changeTypeFor(field) {
  switch (field) {
    case "title": return "title_changed";
    case "meta_description": return "meta_changed";
    case "status_code": return "status_changed";
    case "indexable": return "indexability_changed";
    case "content": return "content_changed";
    default: return `field_${field}_changed`;
  }
}

async function init() {
  await authWorker(client, { adminEmail: PB_ADMIN_EMAIL, adminPassword: PB_ADMIN_PASSWORD });
  console.log(`[worker] authenticated as ${PB_ADMIN_EMAIL} | poll=${POLL_INTERVAL}ms maxPages=${MAX_PAGES} concurrency=${CONCURRENCY}`);
  // ONE_SHOT: process a single queued job then exit (used for tests / manual runs).
  if (process.env.ONE_SHOT === "1") {
    const job = await claimNextJob(client);
    if (job) await processJob(job);
    else console.log("[worker] no queued jobs; exiting");
    return;
  }
  while (!terminating) {
    try {
      const job = await claimNextJob(client);
      if (job) await processJob(job);
    } catch (e) {
      console.error("[worker] loop error:", e?.message || e);
    }
    await sleep(POLL_INTERVAL);
  }
  console.log("[worker] graceful shutdown");
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

init();