// External research: provider abstraction + SSRF-safe source fetching.
//
// ResearchProvider.search(query, opts) -> [{ url, title, description }]
//   Providers only DISCOVER candidate URLs. They never produce facts.
// fetchSource(url) -> fetched through OUR infrastructure with fail-closed SSRF
//   protection on the initial URL, on every redirect hop, and at socket
//   connect time (custom DNS lookup) so DNS rebinding cannot reach internal hosts.
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import zlib from "node:zlib";
import { isPublicIp, ssrfCheck } from "./ssrf.js";
import { extractTitle, htmlToText, safeText } from "./text.js";

export class ResearchUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "ResearchUnavailableError";
    this.code = "RESEARCH_UNAVAILABLE";
  }
}

export class NullResearchProvider {
  constructor() { this.name = "none"; this.available = false; }
  async search() { throw new ResearchUnavailableError("No external research provider configured"); }
}

export class FirecrawlResearchProvider {
  constructor({ apiKey, baseUrl = "https://api.firecrawl.dev/v1", timeoutMs = 30_000, fetchImpl = globalThis.fetch } = {}) {
    if (!apiKey) throw new Error("FirecrawlResearchProvider requires apiKey");
    this.name = "firecrawl";
    this.available = true;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async search(query, { limit = 5, language, country } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body = { query: safeText(query, 300), limit: Math.max(1, Math.min(10, limit)) };
      if (language) body.lang = language;
      if (country) body.country = String(country).toLowerCase();
      const response = await this.fetch(`${this.baseUrl}/search`, {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new ResearchUnavailableError(`Research provider returned ${response.status}`);
      const json = await response.json();
      if (!json?.success || !Array.isArray(json.data)) throw new ResearchUnavailableError("Research provider returned an unexpected payload");
      return json.data
        .filter((item) => typeof item?.url === "string")
        .map((item) => ({ url: item.url, title: safeText(item.title, 300), description: safeText(item.description, 600) }));
    } catch (error) {
      if (error instanceof ResearchUnavailableError) throw error;
      throw new ResearchUnavailableError(`Research provider failed: ${error?.name === "AbortError" ? "timeout" : error?.message || error}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createResearchProvider(config, options = {}) {
  if (config.research.provider === "firecrawl") {
    return new FirecrawlResearchProvider({ apiKey: config.research.apiKey, baseUrl: config.research.baseUrl, timeoutMs: config.research.timeoutMs, fetchImpl: options.fetchImpl });
  }
  return new NullResearchProvider();
}

// ---------------------------------------------------------------------------
// URL normalization + dedupe

const TRACKING = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|_hs)/i;
export function normalizeSourceUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  let path = url.pathname.replace(/\/+$/, "") || "/";
  path = path.replace(/\/index\.(html?|php|aspx)$/i, "/");
  url.pathname = path;
  const search = url.searchParams.toString();
  return `${url.protocol === "http:" ? "https:" : "https:"}//${url.hostname}${url.port && !["80", "443"].includes(url.port) ? `:${url.port}` : ""}${url.pathname}${search ? `?${search}` : ""}`;
}

export function dedupeSources(candidates) {
  const seen = new Map();
  for (const candidate of candidates) {
    const key = normalizeSourceUrl(candidate.url);
    if (!key) continue;
    if (!seen.has(key)) seen.set(key, { ...candidate, normalized_url: key });
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Source quality classification (deterministic)

const QUALITY = { government: 1, official: 0.95, academic: 0.9, institution: 0.85, manufacturer: 0.8, industry: 0.65, news: 0.55, client_site: 0.5, other: 0.35, blog: 0.25 };
const INSTITUTION_HOSTS = [/(^|\.)who\.int$/, /(^|\.)un\.org$/, /(^|\.)iea\.org$/, /(^|\.)irena\.org$/, /(^|\.)nrel\.gov$/, /(^|\.)worldbank\.org$/, /(^|\.)iso\.org$/, /(^|\.)ieee\.org$/, /(^|\.)wikipedia\.org$/];
const OFFICIAL_HOSTS = [/(^|\.)cfe\.mx$/, /(^|\.)cfe\.gob\.mx$/, /(^|\.)sat\.gob\.mx$/, /(^|\.)profeco\.gob\.mx$/, /(^|\.)fide\.org\.mx$/, /(^|\.)cre\.gob\.mx$/];
const NEWS_HOSTS = [/(^|\.)reuters\.com$/, /(^|\.)apnews\.com$/, /(^|\.)bbc\.(com|co\.uk)$/, /(^|\.)elfinanciero\.com\.mx$/, /(^|\.)eleconomista\.com\.mx$/, /(^|\.)expansion\.mx$/, /(^|\.)nytimes\.com$/, /(^|\.)forbes\.com(\.mx)?$/];
const MANUFACTURER_HOSTS = [/(^|\.)tesla\.com$/, /(^|\.)enphase\.com$/, /(^|\.)sma-america\.com$/, /(^|\.)sma\.de$/, /(^|\.)jinkosolar\.com$/, /(^|\.)canadiansolar\.com$/, /(^|\.)longi\.com$/, /(^|\.)trinasolar\.com$/, /(^|\.)huawei\.com$/, /(^|\.)fronius\.com$/, /(^|\.)growatt\.com$/];

export function classifySource(url, { clientDomain } = {}) {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return { source_type: "other", quality: QUALITY.other, publisher: "" }; }
  const clientHost = String(clientDomain || "").toLowerCase().replace(/^www\./, "");
  let type = "other";
  if (clientHost && (host === clientHost || host.endsWith(`.${clientHost}`))) type = "client_site";
  else if (/(^|\.)(gov|gob|gouv|gc)(\.[a-z]{2})?$/.test(host)) type = "government";
  else if (OFFICIAL_HOSTS.some((re) => re.test(host))) type = "official";
  else if (/\.edu(\.[a-z]{2})?$/.test(host) || /\.ac\.[a-z]{2}$/.test(host) || /\.unam\.mx$/.test(host)) type = "academic";
  else if (INSTITUTION_HOSTS.some((re) => re.test(host))) type = "institution";
  else if (MANUFACTURER_HOSTS.some((re) => re.test(host))) type = "manufacturer";
  else if (NEWS_HOSTS.some((re) => re.test(host))) type = "news";
  else if (/(^|\.)blog\.|\/blog\//.test(host) || /(medium\.com|blogspot\.|wordpress\.com)$/.test(host)) type = "blog";
  return { source_type: type, quality: QUALITY[type], publisher: host };
}

/** Prefer authoritative sources; only fall back to low-quality ones when nothing better exists. */
export function rankSources(sources, max) {
  const sorted = [...sources].sort((a, b) => (b.quality - a.quality) || ((b.relevance || 0) - (a.relevance || 0)));
  const authoritative = sorted.filter((s) => s.quality >= 0.55);
  const pool = authoritative.length >= Math.min(3, max) ? authoritative : sorted;
  return pool.slice(0, max);
}

// ---------------------------------------------------------------------------
// SSRF-safe fetch

function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses?.length) return callback(new Error(`No addresses for ${hostname}`));
    const blocked = addresses.find((entry) => !isPublicIp(entry.address, entry.family));
    if (blocked) {
      const err = new Error(`SSRF blocked: ${hostname} resolved to non-public ${blocked.address}`);
      err.code = "SSRF_BLOCKED";
      return callback(err);
    }
    if (options?.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

function requestOnce(url, { timeoutMs, maxBytes, userAgent }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    if (net.isIP(parsed.hostname.replace(/^\[|\]$/g, "")) && !isPublicIp(parsed.hostname.replace(/^\[|\]$/g, ""), net.isIP(parsed.hostname.replace(/^\[|\]$/g, "")))) {
      const err = new Error(`SSRF blocked: private IP literal ${parsed.hostname}`);
      err.code = "SSRF_BLOCKED";
      return reject(err);
    }
    const req = lib.request(parsed, {
      method: "GET",
      lookup: safeLookup,
      timeout: timeoutMs,
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
      },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ status, location: res.headers.location, headers: res.headers });
      }
      let stream = res;
      const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
      if (encoding === "gzip") stream = res.pipe(zlib.createGunzip());
      else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());
      else if (encoding === "br") stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      let size = 0;
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { req.destroy(); stream.destroy(); resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), truncated: true }); return; }
        chunks.push(chunk);
      });
      stream.on("end", () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      stream.on("error", reject);
    });
    req.on("timeout", () => { req.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })); });
    req.on("error", reject);
    req.end();
  });
}

export async function fetchSource(url, { timeoutMs = 15_000, maxBytes = 1_500_000, maxRedirects = 4, userAgent = "Mozilla/5.0 (compatible; BunkerSEOResearch/0.4; +https://bunkeragent.cloud)" } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const gate = await ssrfCheck(current);
    if (!gate.ok) return { ok: false, ssrfBlocked: true, status: 0, finalUrl: current, error: gate.reason };
    let result;
    try {
      result = await requestOnce(current, { timeoutMs, maxBytes, userAgent });
    } catch (error) {
      return { ok: false, ssrfBlocked: error?.code === "SSRF_BLOCKED", status: 0, finalUrl: current, error: String(error?.message || error) };
    }
    if (result.location) {
      try { current = new URL(result.location, current).toString(); } catch { return { ok: false, status: result.status, finalUrl: current, error: "Invalid redirect" }; }
      continue;
    }
    const contentType = String(result.headers?.["content-type"] || "").toLowerCase();
    const ok = result.status >= 200 && result.status < 300;
    let text = "";
    let title = "";
    if (ok && /html|xml/.test(contentType)) { text = htmlToText(result.body, 12_000); title = extractTitle(result.body); }
    else if (ok && /text\/plain/.test(contentType)) text = safeText(result.body, 12_000);
    return { ok, status: result.status, finalUrl: current, contentType, text, title };
  }
  return { ok: false, status: 0, finalUrl: current, error: "Too many redirects" };
}

// ---------------------------------------------------------------------------
// Research collection

/**
 * Discover + verify external sources for the article. Returns sources with
 * excerpts fetched by us. Never fabricates: if the provider is unavailable the
 * error propagates and the caller decides whether research is required.
 */
export async function collectExternalSources({ provider, queries, language, country, clientDomain, maxSources, fetcher = fetchSource, now = () => new Date().toISOString(), logger = console }) {
  if (!provider?.available) throw new ResearchUnavailableError("No external research provider configured");
  if (maxSources <= 0) return { sources: [], blocked: [], failed: [] };
  const discovered = [];
  let providerErrors = 0;
  for (const query of queries.slice(0, 4)) {
    try {
      const results = await provider.search(query, { limit: Math.min(6, maxSources + 2), language, country });
      for (const item of results) discovered.push({ ...item, query });
    } catch (error) {
      providerErrors++;
      logger.warn?.(`[content-worker] research query failed: ${error.message}`);
    }
  }
  if (providerErrors && providerErrors === Math.min(queries.length, 4)) throw new ResearchUnavailableError("All research queries failed");

  const unique = dedupeSources(discovered)
    .map((item) => ({ ...item, ...classifySource(item.url, { clientDomain }) }))
    .filter((item) => item.source_type !== "client_site");
  const ranked = rankSources(unique, Math.max(maxSources * 2, maxSources));
  const sources = [];
  const blocked = [];
  const failed = [];
  for (const candidate of ranked) {
    if (sources.length >= maxSources) break;
    const fetched = await fetcher(candidate.url);
    if (fetched.ssrfBlocked) { blocked.push({ url: candidate.url, reason: fetched.error }); continue; }
    if (!fetched.ok) { failed.push({ url: candidate.url, status: fetched.status, reason: fetched.error }); continue; }
    sources.push({
      url: candidate.url,
      normalized_url: candidate.normalized_url,
      title: safeText(fetched.title || candidate.title, 400) || candidate.publisher,
      publisher: candidate.publisher,
      source_type: candidate.source_type,
      quality: candidate.quality,
      relevance: null,
      retrieved_at: now(),
      verified_access: true,
      http_status: fetched.status,
      excerpt: safeText(fetched.text || candidate.description, 6_000),
      query: candidate.query,
      notes: fetched.text ? "" : "Page fetched but no readable text extracted; description from search result.",
    });
  }
  return { sources, blocked, failed };
}
