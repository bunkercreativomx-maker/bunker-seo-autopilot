// Rendering fallback for JavaScript-only sites (React/Vite SPAs, Wix…): when the
// crawled HTML has almost no visible text, render the key pages through
// Firecrawl (real browser) so the auto-setup can still learn the business.
// Used ONLY by auto-setup; results stay in memory.

const KEY_PATH = /(servic|service|about|nosotros|quienes|acerca|contact|contacto|faq|preguntas|financ|warrant|garant|pricing|precios|areas|ubicacion|location|commercial|residential|comercial|residencial)/i;

function mdToText(md) {
  return String(md || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`|~-]{1,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function visibleWords(pages) {
  return pages.reduce((n, p) => n + String(p.text_excerpt || "").split(/\s+/).filter(Boolean).length, 0);
}

async function scrape(url, { apiKey, baseUrl, fetchImpl, timeoutMs }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/scrape`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown", "links"], onlyMainContent: false, timeout: Math.max(10_000, timeoutMs - 5_000) }),
    });
    if (!res.ok) throw new Error(`Firecrawl ${res.status}`);
    const json = await res.json();
    return json.data || {};
  } finally {
    clearTimeout(t);
  }
}

/**
 * Returns rendered pages shaped like crawler pages (url, path, title,
 * meta_description, text_excerpt, language, phones, emails, og, status_code).
 */
export async function renderKeyPages(origin, { apiKey, baseUrl = "https://api.firecrawl.dev/v1", fetchImpl = globalThis.fetch, timeoutMs = 45_000, maxPages = 5 } = {}) {
  if (!apiKey) return [];
  const host = new URL(origin).host.replace(/^www\./, "");
  const out = [];
  const toPage = (url, d) => {
    const links = Array.isArray(d.links) ? d.links : [];
    const phones = [...new Set(links.filter((l) => /^tel:/i.test(l)).map((l) => decodeURIComponent(l.replace(/^tel:/i, "")).trim()))].slice(0, 10);
    const emails = [...new Set(links.filter((l) => /^mailto:/i.test(l)).map((l) => l.replace(/^mailto:/i, "").split("?")[0].trim().toLowerCase()))].slice(0, 10);
    const meta = d.metadata || {};
    let path = "/";
    try { path = new URL(url).pathname || "/"; } catch {}
    return {
      url, path, status_code: Number(meta.statusCode) || 200, isHtml: true, rendered: true,
      title: String(meta.title || ""), meta_description: String(meta.description || ""),
      language: String(meta.language || ""), og: { site_name: String(meta.ogSiteName || meta["og:site_name"] || "") },
      text_excerpt: mdToText(d.markdown).slice(0, 6000), phones, emails, links,
    };
  };
  const home = await scrape(origin + "/", { apiKey, baseUrl, fetchImpl, timeoutMs });
  const homePage = toPage(origin + "/", home);
  out.push(homePage);
  const internal = [...new Set(homePage.links
    .filter((l) => { try { const u = new URL(l); return u.host.replace(/^www\./, "") === host && !u.hash; } catch { return false; } })
    .map((l) => l.split("#")[0].replace(/\/$/, "")))]
    .filter((l) => l !== origin && KEY_PATH.test(new URL(l).pathname))
    .slice(0, maxPages - 1);
  for (const url of internal) {
    try { out.push(toPage(url, await scrape(url, { apiKey, baseUrl, fetchImpl, timeoutMs }))); } catch { /* skip */ }
  }
  return out;
}
