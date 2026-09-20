// PocketBase client for the crawler worker.
// Authenticates as the superuser (admin) — the ONLY place admin creds live,
// never exposed to the frontend. Writes to the Phase-2 collections with
// tenant context on every record (organization/client/website).
import PocketBase from "pocketbase";
import { normalizeUrl } from "./normalize.js";

export function createWorkerClient({ url }) {
  const pb = new PocketBase(url);
  return pb;
}

export async function authWorker(pb, { adminEmail, adminPassword }) {
  await pb.collection("_superusers").authWithPassword(adminEmail, adminPassword);
  return pb;
}

/** Claim the next queued crawl job, atomically-ish, and mark it running. */
export async function claimNextJob(pb) {
  const jobs = await pb.collection("crawl_jobs").getList(1, 20, {
    filter: 'status = "queued"',
    sort: "created_at",
  });
  if (jobs.items.length === 0) return null;
  const job = jobs.items[0];
  // optimistic claim
  const claimed = await pb.collection("crawl_jobs").update(job.id, {
    status: "running",
    started_at: new Date().toISOString(),
  });
  return claimed;
}

/** Validate ownership consistency before crawling (reject forged ids). */
export async function resolveJobContext(pb, job) {
  if (job.status !== "running") return { ok: false, error: "Job is not running" };
  const [website, client, org] = await Promise.all([
    safeGet(pb, "websites", job.website),
    safeGet(pb, "clients", job.client),
    safeGet(pb, "organizations", job.organization),
  ]);
  if (!website || !client || !org) return { ok: false, error: "Missing website/client/organization" };
  // consistency: website.client must equal job.client, and both orgs must match
  if (website.client !== job.client || website.organization !== job.organization) {
    return { ok: false, error: "Website/client/organization relationship inconsistent" };
  }
  if (client.organization !== org.id || client.organization !== website.organization) {
    return { ok: false, error: "Client belongs to a different organization" };
  }
  return { ok: true, website, client, org };
}

async function safeGet(pb, col, id) {
  try {
    return await pb.collection(col).getOne(id);
  } catch {
    return null;
  }
}

/** Fetch existing page ids for a website (for upsert + change detection). */
export async function getExistingPages(pb, websiteId) {
  try {
    return await pb.collection("website_pages").getFullList(10000, { filter: `website = "${websiteId}"` });
  } catch {
    return [];
  }
}

export async function getExistingIssues(pb, websiteId) {
  try {
    return await pb.collection("seo_issues").getFullList(10000, { filter: `website = "${websiteId}"` });
  } catch {
    return [];
  }
}

/** Upsert a page by (website, normalized_url). Returns { id, created, changed }. */
export async function upsertPage(pb, page, ctx) {
  const norm = normalizeUrl(page.url) || page.url;
  const data = {
    organization: ctx.org.id,
    client: ctx.client.id,
    website: ctx.website.id,
    url: page.url,
    normalized_url: norm,
    path: page.path || urlPath(page.url),
    status_code: page.status_code,
    content_type: page.content_type,
    indexable: page.indexable,
    indexability_reason: page.indexability_reason || null,
    canonical_url: page.canonical_url || null,
    title: page.title || null,
    title_length: page.title_length ?? null,
    meta_description: page.meta_description || null,
    meta_description_length: page.meta_description_length ?? null,
    h1: page.h1 || null,
    h1_count: page.h1_count ?? null,
    headings: page.headings || {},
    word_count: page.word_count ?? null,
    language: page.language || null,
    robots_directives: page.robots_directives || [],
    schema_types: page.schema_types || [],
    internal_links_count: page.internal_links_count ?? null,
    external_links_count: page.external_links_count ?? null,
    images_count: page.images_count ?? null,
    images_missing_alt: page.images_missing_alt ?? null,
    content_hash: page.content_hash || null,
    crawl_depth: page.crawl_depth ?? null,
    last_crawled_at: page.last_crawled_at || new Date().toISOString(),
  };
  // drop undefined
  for (const k in data) if (data[k] === undefined) data[k] = null;

  const existing = ctx.existingPages.get(norm);
  if (existing) {
    const changed = detectPageChange(existing, data);
    const updated = await pb.collection("website_pages").update(existing.id, data);
    return { id: updated.id, created: false, changed };
  }
  const created = await pb.collection("website_pages").create(data);
  ctx.existingPages.set(norm, created);
  return { id: created.id, created: true, changed: { new: true } };
}

function detectPageChange(old, next) {
  const diffs = {};
  for (const f of ["title", "meta_description", "status_code", "indexable", "content_hash"]) {
    const a = old[f] ?? null;
    const b = next[f] ?? null;
    if (String(a) !== String(b)) {
      diffs[f === "content_hash" ? "content" : f] = { old: a, new: b };
    }
  }
  return Object.keys(diffs).length ? diffs : null;
}

export function urlPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "/";
  }
}

/**
 * Persist a page's internal links. Returns created record ids.
 * Deduplicates by (source_page, destination_url).
 */
export async function persistLinks(pb, pageId, links, ctx) {
  const created = [];
  const seen = new Set();
  for (const link of links) {
    const destNorm = normalizeUrl(link.destination_url);
    if (!destNorm) continue;
    const key = `${pageId}::${destNorm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // resolve whether dest was crawled (internal only)
    let destinationPage = null;
    if (link.link_type === "internal") {
      destinationPage = ctx.existingPages.get(destNorm)?.id ?? null;
    }
    try {
      await pb.collection("page_links").create({
        organization: ctx.org.id,
        client: ctx.client.id,
        website: ctx.website.id,
        source_page: pageId,
        destination_url: destNorm,
        destination_page: destinationPage || undefined,
        anchor_text: link.anchor_text || "",
        link_type: link.link_type,
        status_code: null, // resolved post-crawl in a second pass (see worker)
        created_at: new Date().toISOString(),
      });
      created.push(destNorm);
    } catch {}
  }
  return created;
}

/** Snapshot summary after a crawl. */
export async function createSnapshot(pb, ctx, crawlJobId, counts, issueCounts) {
  return pb.collection("website_snapshots").create({
    organization: ctx.org.id,
    client: ctx.client.id,
    website: ctx.website.id,
    crawl_job: crawlJobId,
    total_pages: counts.total_pages || 0,
    indexable_pages: counts.indexable ?? 0,
    non_indexable_pages: counts.nonIndexable ?? 0,
    broken_pages: counts.broken ?? 0,
    total_issues: issueCounts.total ?? 0,
    critical_issues: issueCounts.critical ?? 0,
    high_issues: issueCounts.high ?? 0,
    medium_issues: issueCounts.medium ?? 0,
    low_issues: issueCounts.low ?? 0,
    opportunities: issueCounts.opportunity ?? 0,
    created_at: new Date().toISOString(),
  });
}

export async function updateJobProgress(pb, jobId, fields) {
  try {
    return await pb.collection("crawl_jobs").update(jobId, { ...fields });
  } catch {
    return null;
  }
}