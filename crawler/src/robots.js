// robots.txt fetching + parsing (sitemap references, basic crawl restrictions).
import { safeFetch } from "./fetch.js";

/**
 * Fetch and interpret /robots.txt for a website origin.
 * Returns { exists, status, content, sitemaps: [...], blocked: bool }
 * `blocked` true when robots.txt disallows the crawler's paths (robust-ish check).
 */
export async function fetchRobots(origin) {
  const url = new URL("/robots.txt", origin).toString();
  const res = await safeFetch(url);
  if (res.ssrfBlocked) return { exists: false, status: 0, content: "", sitemaps: [], blocked: false, error: res.error };
  if (res.status === 404) return { exists: false, status: 404, content: "", sitemaps: [], blocked: false };
  if (res.status !== 200) return { exists: false, status: res.status, content: "", sitemaps: [], blocked: false, error: `status ${res.status}` };
  if (!res.html || !isText(res.headers["content-type"])) return { exists: true, status: 200, content: "", sitemaps: [], blocked: false, error: "non-text robots.txt" };

  const text = res.html;
  const sitemaps = [];
  let blocked = false;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*Sitemap:\s*(.+)\s*$/i.exec(line);
    if (m) { sitemaps.push(m[1].trim()); continue; }
    if (/^\s*User-agent:\s*\*/i.test(line)) {
      // wildcard group: check subsequent disallow lines
      blocked = blockedGroup(text, line);
    }
  }
  return { exists: true, status: 200, content: text, sitemaps, blocked };
}

function blockedGroup(text, uaLine) {
  const idx = text.indexOf(uaLine);
  const rest = text.slice(idx);
  const nextUa = rest.slice(1).search(/^\s*User-agent:/m);
  const group = nextUa === -1 ? rest : rest.slice(0, nextUa);
  // A Disallow: / would suggest nothing below root is allowed.
  if (/^\s*Disallow:\s*\/\s*$/mi.test(group)) return true;
  return false;
}

export function isText(contentType) {
  const ct = (contentType || "").toLowerCase();
  return ct.includes("text/") || ct.includes("application/x-robots") || ct.includes("application/octet-stream") || ct === "";
}