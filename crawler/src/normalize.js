// URL normalization utilities (shared by discovery, crawler, issue engine).

/**
 * Normalize a URL for dedup: lowercase scheme+host, drop default ports,
 * strip fragment, strip tracking-ish query keys optionally, resolve trailing slash.
 * Returns null for non-http(s) / mailto / tel / javascript / data URLs.
 */
export function normalizeUrl(input, { keepQuery = true } = {}) {
  let u;
  try {
    u = new URL(input);
  } catch {
    return null; // invalid -> caller decides (page fetch error)
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  u.hash = "";
  try {
    u.username = "";
    u.password = "";
  } catch {}

  if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
    u.port = "";
  }

  let path = u.pathname;
  // canonicalize: collapse duplicate slashes, resolve dot segments
  path = collapseSlashes(path);
  u.pathname = path;

  // normalize trailing slash only for empty-ish paths
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
    if (u.pathname === "") u.pathname = "/";
  }

  if (!keepQuery) u.search = "";

  return u.toString();
}

export function collapseSlashes(p) {
  // "/a//b/" -> "/a/b/"
  let out = p.replace(/\/{2,}/g, "/");
  // resolve dot segments (/a/../b -> /b, /a/./b -> /a/b)
  const segs = out.split("/");
  const stack = [];
  for (const s of segs) {
    if (s === "." || s === "") continue;
    if (s === "..") { stack.pop(); continue; }
    stack.push(s);
  }
  let joined = "/" + stack.join("/");
  if (p.endsWith("/") && !joined.endsWith("/") && joined !== "/") joined += "/";
  return joined === "" ? "/" : joined;
}

/** True if two normalized strings refer to the same page (ignores query when flag set). */
export function sameUrl(a, b, { ignoreQuery = true } = {}) {
  const na = normalizeUrl(a, { keepQuery: !ignoreQuery });
  const nb = normalizeUrl(b, { keepQuery: !ignoreQuery });
  if (!na || !nb) return false;
  return na === nb;
}

/** Is this a crawlable (non-skip) URL scheme? */
export function isSkipScheme(raw) {
  return /^(mailto:|tel:|javascript:|data:|#)/i.test(raw.trim());
}

/** Resolve a relative href against a base URL. Returns null if unparseable. */
export function resolveHref(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/** Same registrable-ish domain check (used for internal vs external links). */
export function sameHost(base, target) {
  try {
    const a = new URL(base);
    const b = new URL(target);
    return a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "");
  } catch {
    return false;
  }
}

/**
 * Click depth estimate from a URL path (number of path segments).
 * Homepage "/" -> depth 1.
 */
export function pathDepth(url) {
  try {
    const path = new URL(url).pathname;
    if (path === "/" || path === "") return 1;
    return path.split("/").filter(Boolean).length;
  } catch {
    return 1;
  }
}