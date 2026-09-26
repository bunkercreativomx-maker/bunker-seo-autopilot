// SEO extraction from fetched HTML pages (title, meta, canonical, robots, H1/H2/H3,
// language, OG, schema JSON-LD, word count, internal/external links, images/alt).
import * as cheerio from "cheerio";
import { resolveHref, sameHost, normalizeUrl, isSkipScheme } from "./normalize.js";

/**
 * Extract structured SEO data from an HTML string.
 * Returns a flat object aligned with the website_pages collection fields.
 */
export function extractSeo(html, pageUrl) {
  const $ = cheerio.load(html);

  // --- platform hint (for auto-setup) ---
  const generator = ($('meta[name="generator" i]').attr("content") || "").toLowerCase();
  const platformHint = /wordpress/.test(generator) || /\/wp-content\/|\/wp-includes\//.test(html) ? "wordpress"
    : (/id="__next"|__NEXT_DATA__|\/_next\/static\//.test(html) ? "nextjs" : "");

  // --- title ---
  const title = $("head title").first().text().trim() || "";

  // --- meta description ---
  const metaDesc = $('meta[name="description" i]').first().attr("content")?.trim() || "";

  // --- canonical ---
  const canonical = $('link[rel="canonical" i]').first().attr("href")?.trim() || "";

  // --- meta robots + X-Robots-Tag (handled by caller from headers) ---
  const metaRobots = $('meta[name="robots" i]').first().attr("content")?.toLowerCase() || "";

  // --- headings ---
  const h1s = [];
  const headings = { h1: [], h2: [], h3: [] };
  $("h1, h2, h3").each((_, el) => {
    const tag = (el.tagName || "h").toLowerCase();
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!text) return;
    headings[tag] = headings[tag] || [];
    headings[tag].push(text);
    if (tag === "h1") h1s.push(text);
  });

  // --- language ---
  const lang = ($("html").attr("lang") || "").trim();

  // --- Open Graph basics ---
  const og = {};
  $('meta[property^="og:" i]').each((_, el) => {
    const key = $(el).attr("property").replace(/^og:/, "");
    if (!og[key]) og[key] = $(el).attr("content")?.trim() || "";
  });

  // --- JSON-LD schema types ---
  const schemaTypes = [];
  let invalidSchema = false;
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().first().text().trim();
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      const walkTypes = (node) => {
        if (!node) return;
        if (Array.isArray(node)) { node.forEach(walkTypes); return; }
        if (typeof node === "object" && node["@type"]) {
          schemaTypes.push(...(Array.isArray(node["@type"]) ? node["@type"] : [String(node["@type"])]));
        }
        for (const k in node) if (typeof node[k] === "object") walkTypes(node[k]);
      };
      walkTypes(data);
    } catch {
      invalidSchema = true;
    }
  });

  // --- word count (strip scripts/styles/tags) ---
  $("script, style, noscript, svg, template").remove();
  const textContent = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = textContent ? textContent.split(" ").filter(Boolean).length : 0;
  // Short visible-text excerpt, used ONLY in memory by the auto-setup profile
  // step (never persisted).
  const textExcerpt = textContent.slice(0, 6000);
  // content hash over visible text
  const contentHash = hashString(textContent);

  // --- links ---
  const internalLinks = [];
  const externalLinks = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href").trim();
    if (!href || isSkipScheme(href)) return;
    const absolute = resolveHref(pageUrl, href);
    if (!absolute) return;
    const anchor = $(el).text().replace(/\s+/g, " ").trim();
    if (sameHost(pageUrl, absolute)) {
      const norm = normalizeUrl(absolute);
      if (norm) internalLinks.push({ url: norm, anchor });
    } else {
      const norm = normalizeUrl(absolute);
      if (norm) externalLinks.push({ url: norm, anchor });
    }
  });
  // count unique internal destinations
  const uniqueInternal = new Set(internalLinks.map((l) => l.url));

  // --- emails (mailto:) for the auto-setup profile ---
  const emails = [];
  $('a[href^="mailto:" i]').each((_, el) => {
    const v = ($(el).attr("href") || "").replace(/^mailto:/i, "").split("?")[0].trim().toLowerCase();
    if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(v) && !emails.includes(v)) emails.push(v);
  });
  const phones = [];
  $('a[href^="tel:" i]').each((_, el) => {
    const v = ($(el).attr("href") || "").replace(/^tel:/i, "").trim();
    if (v && !phones.includes(v)) phones.push(v);
  });

  // --- images ---
  let images = 0;
  let missingAlt = 0;
  const imageList = [];
  $("img").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src") || "";
    const alt = $(el).attr("alt") ?? "";
    images++;
    if (!alt.trim()) missingAlt++;
    imageList.push({ src, alt: alt.trim() });
  });

  // --- local SEO signals (only what is found, never invented) ---
  const localSignals = {
    businessName: findMeta($, "og:site_name") || $(".vcard .fn, .business-name, .organization-name").first().text().trim() || "",
    phone: findMeta($, "og:phone_number") || $('a[href^="tel:"]').first().attr("href")?.replace(/^tel:/, "").trim() || "",
    address: $("[itemprop='address'], .address, .adr").first().text().replace(/\s+/g, " ").trim() || "",
    hasLocalBusinessSchema: schemaTypes.includes("LocalBusiness") || schemaTypes.some((t) => /Business|Organization/.test(t)),
    serviceAreas: $("[itemprop='areaServed']").map((_, el) => $(el).text().trim()).get().filter(Boolean),
  };

  const robotsDirectives = [];
  if (metaRobots) robotsDirectives.push(...metaRobots.split(/[,\s]+/).filter(Boolean));

  return {
    url: pageUrl,
    title,
    title_length: title.length,
    meta_description: metaDesc,
    meta_description_length: metaDesc.length,
    canonical_url: canonical,
    meta_robots: metaRobots,
    robots_directives: [...new Set(robotsDirectives)],
    h1: h1s.join(" | "),
    h1_count: h1s.length,
    headings,
    language: lang,
    og,
    schema_types: [...new Set(schemaTypes)],
    invalid_schema: invalidSchema,
    word_count: wordCount,
    content_hash: contentHash,
    internal_links: internalLinks,
    internal_links_count: uniqueInternal.size,
    external_links: externalLinks,
    external_links_count: externalLinks.length,
    images_count: images,
    images_missing_alt: missingAlt,
    images: imageList.slice(0, 200),
    local_signals: localSignals,
    title_duplicate_group: null,
    text_excerpt: textExcerpt,
    platform_hint: platformHint,
    emails: emails.slice(0, 10),
    phones: phones.slice(0, 10),
  };
}

function findMeta($, prop) {
  return $(`meta[property="${prop}" i]`).attr("content")?.trim() || "";
}

/** Cheap deterministic content hash (djb2) over normalized text. */
export function hashString(s) {
  let h = 5381;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

/** Determine indexability from HTTP status + meta robots + X-Robots-Tag + canonical. */
export function determineIndexable({ statusCode, metaRobots, xRobots, canonical, canonicalSamePage }) {
  if (statusCode >= 400 || statusCode === 0) return { indexable: false, reason: statusCode >= 500 ? "Error" : statusCode === 0 ? "Error" : "Redirect/Error" };
  if (statusCode >= 300 && statusCode < 400) return { indexable: false, reason: "Redirect" };
  const dirs = `${metaRobots} ${xRobots || ""}`.toLowerCase();
  if (/noindex/.test(dirs)) return { indexable: false, reason: "Noindex" };
  if (/nofollow/.test(dirs)) return { indexable: true, reason: "Indexable (nofollow links)" };
  if (canonical && !canonicalSamePage) return { indexable: true, reason: "Canonicalized to other URL" };
  return { indexable: true, reason: "Indexable" };
}