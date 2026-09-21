// Deterministic SEO issue engine. No AI needed for basic problems.
// Each rule produces zero or more issue descriptors.

// Severity values: critical | high | medium | low | opportunity

/**
 * Produce per-page issues from an extracted page + fetch context.
 * `fetchInfo`: { statusCode, finalUrl, contentType, xRobots, redirects[], truncated, downloadedFrom }
 * Returns array of { issue_type, severity, category, title, description, evidence, recommended_action }.
 */
export function pageIssues(page, fetchInfo) {
  const issues = [];
  const add = (issue_type, severity, category, title, description, evidence, recommended_action) =>
    issues.push({ issue_type, severity, category, title, description, evidence, recommended_action });

  const status = fetchInfo.statusCode;

  // --- status / technical ---
  if (status === 0) {
    add("fetch_error", "high", "technical", "Page failed to fetch", `Could not retrieve this page.`, { error: fetchInfo.error || "unknown" }, "Check the URL is reachable and returns a valid response.");
  } else if (status >= 500) {
    add("server_error", "critical", "technical", `Server error (${status})`, `The page returned HTTP ${status}.`, { status }, "Fix the server-side error so the page returns 200.");
  } else if (status === 404) {
    add("page_404", "high", "technical", "Page returns 404", `HTTP ${status}.`, { status }, "Remove, redirect, or restore this URL.");
  } else if (status >= 400) {
    add("page_error", "high", "technical", `HTTP error (${status})`, `The page returned HTTP ${status}.`, { status }, "Investigate why this URL errors.");
  } else if (fetchInfo.redirects && fetchInfo.redirects.length >= 3) {
    add("redirect_chain", "low", "technical", `Long redirect chain (${fetchInfo.redirects.length} hops)`, "This URL redirects multiple times before serving content.", { hops: fetchInfo.redirects.length }, `Reduce redirect hops (target ≈${fetchInfo.redirects.at(-1)?.to || ""}).`);
  } else if (status >= 300 && status < 400) {
    add("redirect_3xx", "low", "technical", `Redirect (${status})`, "This URL is a 3xx redirect; page content is served elsewhere.", { status }, "Ensure the final page is indexable and internal links point to the final URL.");
  }

  // content-type is non-HTML -> only status issues apply
  if (page.html === null || !page.isHtml) return issues;

  // --- title ---
  if (!page.title) {
    add("missing_title", "high", "on_page", "Missing page title", "No <title> tag found.", {}, "Add a descriptive title reflecting the page topic/business.");
  } else {
    if (page.title_length < 15) add("very_short_title", "medium", "on_page", "Very short title", `Title is only ${page.title_length} chars.`, { title: page.title, length: page.title_length }, "Lengthen the title to better describe the page (length is a heuristic, not a Google rule).");
    if (page.title_length > 70) add("very_long_title", "low", "on_page", "Long title", `Title is ${page.title_length} chars and may truncate in SERPs.`, { length: page.title_length }, "Consider shortening to ~50-60 chars for better display.");
  }

  // --- meta description ---
  if (!page.meta_description) {
    add("missing_meta_description", "medium", "on_page", "Missing meta description", "No meta description found.", {}, "Write a 150-160 char description summarizing the page.");
  } else {
    if (page.meta_description_length < 50) add("very_short_meta_description", "low", "on_page", "Very short meta description", `Description is only ${page.meta_description_length} chars.`, { length: page.meta_description_length }, "Expand the description (length is a heuristic).");
    if (page.meta_description_length > 200) add("very_long_meta_description", "low", "on_page", "Long meta description", `Description is ${page.meta_description_length} chars.`, {}, "Shorten to ~160 chars.");
  }

  // --- canonical ---
  if (!page.canonical_url) {
    add("missing_canonical", "low", "on_page", "Missing canonical tag", "No canonical URL declared.", {}, "Add a self-referencing canonical to avoid duplicate-content ambiguity.");
  } else if (!fetchInfo.canonicalSamePage) {
    // canonical points elsewhere (external or different path)
    if (!/^https?:\/\//i.test(page.canonical_url)) {
      add("canonical_relative", "low", "on_page", "Relative canonical URL", "Canonical is a relative URL.", { canonical: page.canonical_url }, "Use absolute canonical URLs.");
    } else if (fetchInfo.canonicalHttpError) {
      add("canonical_non200", "medium", "on_page", "Canonical points to a non-200 page", "The declared canonical target does not resolve to 200.", { canonical: page.canonical_url }, "Point the canonical at a healthy, indexable URL.");
    }
  }

  // --- H1 ---
  if (page.h1_count === 0) {
    add("missing_h1", "medium", "on_page", "Missing H1", "No H1 heading found on the page.", {}, "Add a single descriptive H1 reflecting the page's main topic.");
  } else if (page.h1_count > 1) {
    add("multiple_h1", "opportunity", "on_page", "Multiple H1 headings", `${page.h1_count} H1 headings found.`, { h1: page.h1 }, "Use one H1 per page (multiple is generally not penalized automatically).");
  }

  // --- content ---
  if (page.word_count === 0) {
    add("empty_content", "high", "content", "Empty page content", "No visible text content detected.", {}, "Add meaningful content to this page.");
  } else if (page.word_count < 150) {
    add("very_thin_content", "medium", "content", "Very thin content", `Only ~${page.word_count} words on the page.`, { wordCount: page.word_count }, "Add substantive content (thin content is a heuristic).");
  }

  // --- images ---
  if (page.images_count > 0 && page.images_missing_alt === page.images_count) {
    // all images missing alt
    add("missing_alt", "medium", "content", "Images missing alt text", `${page.images_missing_alt} of ${page.images_count} images have no alt attribute.`, { missing: page.images_missing_alt, total: page.images_count }, "Add descriptive alt text to content images (decorative images may be hidden).");
  } else if (page.images_missing_alt > 0) {
    add("missing_alt", "low", "content", `Missing alt on ${page.images_missing_alt} image(s)`, `${page.images_missing_alt} image(s) lack alt text.`, { missing: page.images_missing_alt, total: page.images_count }, "Add alt text to content-bearing images.");
  }

  // --- schema ---
  if (page.invalid_schema) {
    add("invalid_schema", "medium", "structured_data", "Invalid JSON-LD", "A JSON-LD script contains invalid JSON.", {}, "Fix the malformed structured data block.");
  } else if (page.schema_types.length === 0) {
    add("no_structured_data", "opportunity", "structured_data", "No structured data detected", "No JSON-LD schema found.", {}, "Add relevant structured data (LocalBusiness, FAQ, etc.).");
  }

  // --- indexability ---
  if (!page.indexable && page.indexability_reason === "Noindex") {
    add("noindex_page", "medium", "indexability", "Page is noindex", "This page is marked noindex.", {}, "Remove noindex if this page should be indexed.");
  }

  return issues;
}

/**
 * Cross-page issues computed from the full crawl result set:
 *  - duplicate titles / meta descriptions (same content on 2+ pages)
 *  - broken internal links (source page links to a page that errored/is missing)
 *  - potential orphan pages (in sitemap but no internal links to them)
 */
export function crossPageIssues({ pages, links, sitemapUrls }) {
  const issues = [];
  const byTitle = new Map();
  const byMeta = new Map();
  const internalDestinations = new Set();

  // normalize: only indexable HTML pages matter for on-page checks
  for (const p of pages) {
    if (p.title) {
      const key = p.title.toLowerCase().trim();
      if (!byTitle.has(key)) byTitle.set(key, []);
      byTitle.get(key).push(p);
    }
    if (p.meta_description) {
      const key = p.meta_description.toLowerCase().trim();
      if (!byMeta.has(key)) byMeta.set(key, []);
      byMeta.get(key).push(p);
    }
  }

  for (const [, group] of byTitle) {
    if (group.length > 1) {
      issues.push({
        issue_type: "duplicate_title",
        severity: "medium",
        category: "on_page",
        title: `Duplicate title (${group.length} pages)`,
        description: `These pages share the title "${group[0].title}".`,
        evidence: { title: group[0].title, pages: group.map((p) => p.url) },
        recommended_action: "Give each page a unique, descriptive title.",
        pages: group.map((p) => p.url),
        pages_ids: group.map((p) => p.id).filter(Boolean),
      });
    }
  }
  for (const [meta, group] of byMeta) {
    if (group.length > 1) {
      issues.push({
        issue_type: "duplicate_meta_description",
        severity: "low",
        category: "on_page",
        title: `Duplicate meta description (${group.length} pages)`,
        description: `These pages share the same meta description.`,
        evidence: { meta, pages: group.map((p) => p.url) },
        recommended_action: "Write a unique description per page.",
        pages: group.map((p) => p.url),
        pages_ids: group.map((p) => p.id).filter(Boolean),
      });
    }
  }

  // broken internal links: records of source -> dest where dest errored
  for (const link of links) {
    if (link.status_code && link.status_code >= 400 && link.link_type === "internal") {
      issues.push({
        issue_type: "broken_internal_link",
        severity: link.status_code === 404 ? "high" : "medium",
        category: "crawl",
        title: `Broken internal link (${link.status_code})`,
        description: `Page links to ${link.destination_url} which returns ${link.status_code}.`,
        evidence: { source: link.source_url, destination: link.destination_url, status_code: link.status_code, anchor: link.anchor_text || "" },
        recommended_action: "Fix or remove the broken link, or redirect the target.",
        source_url: link.source_url,
        destination_url: link.destination_url,
        source_page_id: link.source_page_id,
      });
    }
    if (link.link_type === "internal") internalDestinations.add(link.destination_url);
  }

  // orphan pages: in sitemap, not linked internally, not homepage
  for (const u of sitemapUrls || []) {
    if (internalDestinations.has(u)) continue;
    const isHome = new URL(u).pathname === "/";
    if (isHome) continue;
    if (pages.some((p) => p.status_code && p.status_code >= 400)) continue;
    issues.push({
      issue_type: "potential_orphan_page",
      severity: "opportunity",
      category: "structure",
      title: "Potential orphan page",
      description: `${u} appears in the sitemap but receives no internal links.`,
      evidence: { url: u },
      recommended_action: "Add internal links to this page from related content.",
      url: u,
    });
  }

  return issues;
}