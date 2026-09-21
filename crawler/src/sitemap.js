// Sitemap discovery and parsing (XML sitemap + sitemap index + nested sitemaps).
import { safeFetch } from "./fetch.js";
import { normalizeUrl } from "./normalize.js";

/**
 * Parse sitemap XML by extracting every <loc> element (robust across
 * xml namespaces, urlset vs sitemapindex, and malformed nesting). Classifies
 * each loc as a page url vs a nested sitemap by its surrounding tag.
 */
export function parseSitemapXml(text) {
  const urls = new Set();
  const children = new Set();
  const locRe = /<loc[^>]*>([\s\S]*?)<\/loc>/gi;
  let m;
  while ((m = locRe.exec(text)) !== null) {
    const raw = m[1].trim();
    const ref = normalizeUrl(raw);
    if (!ref) continue;
    const before = text.slice(Math.max(0, m.index - 200), m.index);
    const insideSitemap = /<sitemap[^>]*>\s*$/i.test(before);
    if (insideSitemap) children.add(ref);
    else urls.add(ref);
  }
  return { urls: [...urls], children: [...children] };
}

/**
 * Discover sitemap URLs for an origin, from robots references + defaults.
 * Returns { sitemaps: string[], source: "robots" | "defaults" }.
 */
export async function discoverSitemaps(origin, robotsResult = null) {
  const sitemaps = new Set();
  let source = "defaults";
  if (robotsResult?.exists) {
    for (const s of robotsResult.sitemaps) {
      const ref = normalizeUrl(s);
      if (ref) { sitemaps.add(ref); source = "robots"; }
    }
  }
  for (const p of ["/sitemap.xml", "/sitemap_index.xml"]) {
    const ref = normalizeUrl(new URL(p, origin).toString());
    if (ref && ![...sitemaps].includes(ref) && sitemaps.size === 0) {
      sitemaps.add(ref);
    }
  }
  // If robots gave sitemaps, only use those (defaults are fallback when robots has none).
  if (robotsResult?.exists && robotsResult.sitemaps.length > 0) {
    return { sitemaps: [...sitemaps], source: "robots" };
  }
  return { sitemaps: [...sitemaps], source: sitemaps.size > 0 ? source : "none" };
}

/**
 * Fetch + flatten a sitemap tree (depth-limited) into page URLs.
 * Returns { urls: string[], discoveredSitemaps: string[], errors: string[] }.
 */
export async function crawlSitemapTree(roots) {
  const allUrls = new Set();
  const seenSitemaps = new Set();
  const errors = [];
  const queue = roots.map((r) => ({ url: r, depth: 0 }));
  let fetched = 0;
  const maxDepth = 3;
  const fetchLimit = 40;

  while (queue.length > 0 && fetched < fetchLimit) {
    const { url, depth } = queue.shift();
    const ref = normalizeUrl(url);
    if (!ref || seenSitemaps.has(ref)) continue;
    if (depth > maxDepth) continue;
    seenSitemaps.add(ref);
    const res = await safeFetch(ref);
    if (!res.ok || !res.html) {
      if (res.status !== undefined) errors.push(`${ref} (${res.status || res.error || "error"})`);
      continue;
    }
    fetched++;
    const parsed = parseSitemapXml(res.html);
    for (const p of parsed.urls) allUrls.add(p);
    for (const child of parsed.children) queue.push({ url: child, depth: depth + 1 });
  }
  return { urls: [...allUrls], discoveredSitemaps: [...seenSitemaps], errors };
}