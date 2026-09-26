// Crawl orchestrator — runs ONE crawl job against a target website and returns a
// complete, structured result set ready to persist to PocketBase. All network
// access is SSRF-gated and concurrency/rate limited.
import { safeFetch } from "./fetch.js";
import { ssrfCheck } from "./ssrf.js";
import { normalizeUrl, sameHost } from "./normalize.js";
import { fetchRobots } from "./robots.js";
import { discoverSitemaps, crawlSitemapTree } from "./sitemap.js";
import { extractSeo, determineIndexable } from "./extract.js";
import { crossPageIssues } from "./issues.js";

export const CRAWL_DEFAULTS = {
  maxPages: 500,
  concurrency: 3,
  requestDelayMs: 200,   // polite delay between requests to the same host
  maxPagesPerHostRate: 6,
  sitemapFetchLimit: 40,
};

/**
 * Run a crawl for one website.
 * @param {string} websiteDomain  e.g. "example.com" (no scheme)
 * @param {object} opts           override limits
 * @returns {object} { success, error, origin, robots, sitemaps, pages, links, issues,
 *                      discoveredUrls, failed, snapshot }
 * pages: array of page records (normalized) — see crawlPage.
 */
export async function runCrawl(websiteDomain, opts = {}) {
  const cfg = { ...CRAWL_DEFAULTS, ...opts };
  let origin;
  try {
    origin = new URL(`https://${websiteDomain.replace(/^https?:\/\//, "")}`).toString().replace(/\/$/, "");
  } catch {
    return { success: false, error: `Invalid website domain: ${websiteDomain}` };
  }

  // SSRF gate on the origin before anything
  const gate = await ssrfCheck(origin + "/");
  if (!gate.ok) return { success: false, error: `Blocked target: ${gate.reason}` };

  const pages = [];
  const links = [];            // link records {source_url, destination_url, anchor_text, link_type, status_code, source_page_id}
  const failed = [];
  const discovered = new Set();
  const visited = new Set();
  const seenExternals = new Set();

  // 1) robots.txt
  const robots = await fetchRobots(origin);

  // 2) sitemap discovery
  const sm = await discoverSitemaps(origin, robots);
  let sitemapUrls = [];
  let discoveredSitemaps = [];
  let sitemapErrors = [];
  let sitemapSource = sm.source;
  if (sm.sitemaps.length > 0) {
    const tree = await crawlSitemapTree(sm.sitemaps);
    sitemapUrls = tree.urls;
    discoveredSitemaps = tree.discoveredSitemaps;
    sitemapErrors = tree.errors;
    sitemapSource = sm.source;
  }

  // seed discovery set from sitemap
  for (const u of sitemapUrls) {
    const n = normalizeUrl(u);
    if (n) { discovered.add(n); }
  }
  // always include homepage
  discovered.add(origin + "/");

  // 3) BFS crawl with concurrency + rate limiting
  const queue = [...discovered];
  const inFlight = new Set();

  const throttle = async () => {
    if (cfg.requestDelayMs > 0) await new Promise((r) => setTimeout(r, cfg.requestDelayMs));
  };

  async function crawlUrl(url) {
    const norm = normalizeUrl(url);
    if (!norm || visited.has(norm)) return;
    if (visited.size >= cfg.maxPages) return;
    visited.add(norm);
    const res = await safeFetch(norm);

    const fetchInfo = {
      statusCode: res.status,
      finalUrl: res.finalUrl,
      contentType: res.headers?.["content-type"] || "",
      xRobots: res.headers?.["x-robots-tag"] || "",
      redirects: res.redirects || [],
      truncated: !!res.truncated,
      error: res.error,
      ssrfBlocked: !!res.ssrfBlocked,
    };
    if (res.ssrfBlocked || res.status === 0) {
      failed.push({ url: norm, error: res.error || `status ${res.status}` });
      pages.push(buildErrorPage(norm, fetchInfo));
      return;
    }

    const isHtml = (res.headers?.["content-type"] || "").toLowerCase().includes("text/html");
    let page = buildErrorPage(norm, fetchInfo);
    page.isHtml = isHtml;

    if (isHtml && res.html && !res.truncated) {
      try {
        const seo = extractSeo(res.html, norm);
        const canonicalSamePage = seo.canonical_url && sameUrlOf(seo.canonical_url, norm);
        const canonicalHttpError = null;
        const idx = determineIndexable({
          statusCode: res.status,
          metaRobots: seo.meta_robots,
          xRobots: fetchInfo.xRobots,
          canonical: seo.canonical_url,
          canonicalSamePage: !seo.canonical_url || canonicalSamePage,
        });
        page = {
          ...buildErrorPage(norm, fetchInfo),
          isHtml: true,
          title: seo.title,
          title_length: seo.title_length,
          meta_description: seo.meta_description,
          meta_description_length: seo.meta_description_length,
          canonical_url: seo.canonical_url,
          robots_directives: seo.robots_directives,
          h1: seo.h1,
          h1_count: seo.h1_count,
          headings: seo.headings,
          word_count: seo.word_count,
          language: seo.language,
          schema_types: seo.schema_types,
          invalid_schema: seo.invalid_schema,
          internal_links_count: seo.internal_links_count,
          external_links_count: seo.external_links_count,
          images_count: seo.images_count,
          images_missing_alt: seo.images_missing_alt,
          content_hash: seo.content_hash,
          indexable: idx.indexable,
          indexability_reason: idx.reason,
          canonicalSamePage,
          canonicalHttpError,
          local_signals: seo.local_signals,
          og: seo.og,
          text_excerpt: seo.text_excerpt,
          platform_hint: seo.platform_hint,
          emails: seo.emails,
          phones: seo.phones,
          crawl_depth: pathDepthOf(norm),
          last_crawled_at: new Date().toISOString(),
        };
        fetchInfo.canonicalSamePage = canonicalSamePage;
        fetchInfo.canonicalHttpError = canonicalHttpError;

        // --- link discovery for BFS + link graph ---
        for (const l of seo.internal_links) {
          // register link record (cap recorded links to avoid runaway lists)
          if (links.length < 50000) links.push({ source_url: norm, destination_url: l.url, anchor_text: l.anchor, link_type: "internal" });
          if (visited.size < cfg.maxPages && queue.length < cfg.maxPages * 4 && !visited.has(l.url)) queue.push(l.url);
        }
        for (const l of seo.external_links) {
          if (seenExternals.has(l.url)) continue;
          seenExternals.add(l.url);
          links.push({ source_url: norm, destination_url: l.url, anchor_text: l.anchor, link_type: "external" });
        }
      } catch (e) {
        page.fetchError = `Extraction failed: ${e.message}`;
      }
    } else if (res.status >= 300 && res.status < 400 && res.headers?.["location"]) {
      // redirect to another page on same site -> follow
      try {
        const loc = new URL(res.headers.location, norm);
        if (sameHost(origin, loc.toString())) queue.push(loc.toString());
      } catch {}
    }

    pages.push(page);
  }

  // --- concurrency loop ---
  while (queue.length > 0 || inFlight.size > 0) {
    // stop enqueueing once we've hit the page budget
    while (inFlight.size < cfg.concurrency && queue.length > 0) {
      if (visited.size >= cfg.maxPages) break; // budget reached -> stop crawling
      const next = queue.shift();
      inFlight.add(next);
      crawlUrl(next).finally(() => {
        inFlight.delete(next);
      });
      if (cfg.requestDelayMs > 0) await throttle();
    }
    if (visited.size >= cfg.maxPages && inFlight.size === 0) break;
    await new Promise((r) => setTimeout(r, 60));
  }

  // --- cross-page issues ---
  const cross = crossPageIssues({
    pages: pages.filter((p) => p.isHtml !== false),
    links,
    sitemapUrls,
    siteDomain: origin,
  });

  // attach issue lists to pages + ids resolved later by the worker
  return {
    success: true,
    origin,
    robots,
    sitemapSource,
    sitemaps: discoveredSitemaps,
    sitemapErrors,
    sitemapUrls,
    discovered: [...discovered],
    pages,
    links,
    failed,
    crossIssues: cross,
    counts: {
      total_pages: pages.length,
      indexable: pages.filter((p) => p.indexable).length,
      nonIndexable: pages.filter((p) => p.indexable === false).length,
      broken: pages.filter((p) => p.status_code && p.status_code >= 400).length,
      links: links.length,
    },
  };
}

function buildErrorPage(url, fi) {
  return {
    url,
    normalized_url: normalizeUrl(url) || url,
    path: urlPath(url),
    status_code: fi.statusCode,
    content_type: fi.contentType,
    final_url: fi.finalUrl,
    isHtml: false,
    indexable: fi.statusCode >= 200 && fi.statusCode < 300,
    indexability_reason: fi.statusCode >= 200 && fi.statusCode < 300 ? "Indexable" : "Error",
    title: "",
    title_length: 0,
    meta_description: "",
    meta_description_length: 0,
    canonical_url: "",
    robots_directives: [],
    h1: "",
    h1_count: 0,
    headings: {},
    word_count: 0,
    language: "",
    schema_types: [],
    invalid_schema: false,
    internal_links_count: 0,
    external_links_count: 0,
    images_count: 0,
    images_missing_alt: 0,
    content_hash: "",
    crawl_depth: pathDepthOf(url),
    last_crawled_at: new Date().toISOString(),
  };
}

function sameUrlOf(a, b) {
  try {
    return normalizeUrl(a) === normalizeUrl(b);
  } catch {
    return false;
  }
}

function urlPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "/";
  }
}

function pathDepthOf(url) {
  try {
    const p = new URL(url).pathname;
    if (p === "/") return 1;
    return p.split("/").filter(Boolean).length;
  } catch {
    return 1;
  }
}