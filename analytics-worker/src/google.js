// Google OAuth token refresh + Search Console API client (read-only).
// Tokens are never logged; error messages are sanitized before storage.
import { addDays, isDate } from "./dates.js";

export const READONLY_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
export const MAX_ROW_LIMIT = 25000;

export class GoogleError extends Error {
  constructor(code, message, { status = 0, retryable = false, retryAfterMs = 0 } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

export function endpoints(env = process.env) {
  return {
    token: env.GSC_GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token",
    api: (env.GSC_API_BASE || "https://www.googleapis.com/webmasters/v3").replace(/\/+$/, ""),
  };
}

/** Remove anything that looks like a credential from an error string. */
export function sanitize(text) {
  return String(text || "")
    .replace(/ya29\.[\w.-]+/g, "[REDACTED]")
    .replace(/1\/\/[\w.-]+/g, "[REDACTED]")
    .replace(/(access_token|refresh_token|client_secret|id_token|code)["'=:\s]+[\w./-]+/gi, "$1=[REDACTED]")
    .slice(0, 500);
}

/**
 * Wrap a request with bounded retries: 429, 5xx and network errors retry with
 * exponential backoff + jitter (respecting Retry-After). Auth errors never retry.
 */
export async function withRetry(fn, { attempts = 5, baseMs = 1000, maxMs = 30000, sleep = sleepDefault, onRetry } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      last = e;
      if (!e?.retryable || i === attempts) throw e;
      const backoff = Math.min(maxMs, baseMs * 2 ** (i - 1)) + Math.floor(Math.random() * 250);
      const wait = Math.max(backoff, e.retryAfterMs || 0);
      onRetry?.(i, e, wait);
      await sleep(wait);
    }
  }
  throw last;
}

async function call(fetchImpl, url, init, label) {
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(60000) });
  } catch (e) {
    throw new GoogleError("NETWORK_ERROR", `${label}: network error (${sanitize(e?.message)})`, { retryable: true });
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (res.ok) return json || {};
  const retryAfter = Number(res.headers.get("retry-after")) * 1000 || 0;
  const gerr = json?.error;
  const reason = typeof gerr === "string" ? gerr : gerr?.status || gerr?.errors?.[0]?.reason || "";
  const msg = sanitize(typeof gerr === "object" ? gerr?.message : json?.error_description || text);
  if (res.status === 429) throw new GoogleError("RATE_LIMITED", `${label}: rate limited by Google`, { status: 429, retryable: true, retryAfterMs: retryAfter });
  if (res.status >= 500) throw new GoogleError("GOOGLE_UNAVAILABLE", `${label}: Google returned ${res.status}`, { status: res.status, retryable: true, retryAfterMs: retryAfter });
  if (label === "token" && (reason === "invalid_grant" || res.status === 400 || res.status === 401)) throw new GoogleError("REAUTH_REQUIRED", "Google rejected the stored authorization (revoked or expired). Reconnect Search Console.", { status: res.status });
  if (res.status === 401) throw new GoogleError("ACCESS_TOKEN_INVALID", `${label}: access token rejected`, { status: 401 });
  if (res.status === 403) throw new GoogleError("ACCESS_DENIED", `${label}: permission denied for this property (${msg})`, { status: 403 });
  if (res.status === 404) throw new GoogleError("NOT_FOUND", `${label}: property not found`, { status: 404 });
  throw new GoogleError("GOOGLE_ERROR", `${label}: ${res.status} ${msg}`, { status: res.status });
}

export class SearchConsoleClient {
  constructor({ clientId, clientSecret, refreshToken, env = process.env, fetchImpl = fetch, sleep = sleepDefault, logger = console }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.ep = endpoints(env);
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.logger = logger;
    this.accessToken = "";
    this.expiresAt = 0;
    this.requests = 0;
    this.grantedScope = "";
  }

  async token(force = false) {
    if (!force && this.accessToken && Date.now() < this.expiresAt - 60000) return this.accessToken;
    const body = new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, refresh_token: this.refreshToken, grant_type: "refresh_token" });
    const j = await withRetry(() => call(this.fetch, this.ep.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() }, "token"), { attempts: 3, sleep: this.sleep });
    if (!j.access_token) throw new GoogleError("REAUTH_REQUIRED", "Google did not return an access token. Reconnect Search Console.");
    this.accessToken = j.access_token;
    this.expiresAt = Date.now() + (Number(j.expires_in) || 3600) * 1000;
    this.grantedScope = String(j.scope || "");
    return this.accessToken;
  }

  async request(method, path, body, label) {
    const run = async (attempt) => {
      const tok = await this.token(attempt > 1 && this._lastAuthFail);
      this.requests++;
      try {
        const r = await call(this.fetch, `${this.ep.api}${path}`, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, label);
        this._lastAuthFail = false;
        return r;
      } catch (e) {
        // One transparent refresh on an expired access token.
        if (e.code === "ACCESS_TOKEN_INVALID" && !this._lastAuthFail) { this._lastAuthFail = true; e.retryable = true; }
        throw e;
      }
    };
    return withRetry(run, { sleep: this.sleep, onRetry: (i, e, wait) => this.logger.log?.(`[analytics] retry ${label} #${i} ${e.code} in ${wait}ms`) });
  }

  async listSites() {
    const j = await this.request("GET", "/sites", null, "sites.list");
    return (j.siteEntry || []).map((s) => ({ site_url: s.siteUrl, permission_level: s.permissionLevel }));
  }

  /**
   * Paginated Search Analytics query. Stops when a page returns fewer rows
   * than requested or zero rows; a hard page cap prevents runaway loops.
   */
  async queryAll(siteUrl, { startDate, endDate, dimensions, type = "web", dataState = "final", rowLimit = MAX_ROW_LIMIT, maxRows = 500000, onPage } = {}) {
    if (!isDate(startDate) || !isDate(endDate) || startDate > endDate) throw new GoogleError("INVALID_RANGE", "Invalid date range");
    const limit = Math.max(1, Math.min(MAX_ROW_LIMIT, rowLimit));
    const rows = [];
    let startRow = 0, pages = 0, complete = false, requested = 0;
    const maxPages = Math.ceil(maxRows / limit);
    while (pages < maxPages) {
      const body = { startDate, endDate, dimensions, type, dataState, rowLimit: limit, startRow, aggregationType: "auto" };
      requested += limit;
      const j = await this.request("POST", `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, body, "searchAnalytics.query");
      const got = Array.isArray(j.rows) ? j.rows : [];
      pages++;
      for (const r of got) rows.push(r);
      onPage?.({ page: pages, received: got.length, total: rows.length });
      if (got.length === 0 || got.length < limit) { complete = true; break; }
      startRow += got.length;
    }
    return { rows, pages, rowsRequested: requested, paginationCompleted: complete, truncated: !complete };
  }

  /**
   * Latest finalized date: the newest day that has final data. Falls back to
   * Google's `first_incomplete_date` metadata (dataState=all) minus one day.
   * Returns null when the property has no data in the probe window.
   */
  async latestFinalDate(siteUrl, today) {
    const start = addDays(today, -14);
    const fin = await this.queryAll(siteUrl, { startDate: start, endDate: today, dimensions: ["date"], dataState: "final", rowLimit: 100 });
    const dates = fin.rows.map((r) => r.keys?.[0]).filter(isDate).sort();
    if (dates.length) return { date: dates.at(-1), method: "final_rows" };
    const all = await this.request("POST", `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, { startDate: start, endDate: today, dimensions: ["date"], dataState: "all", rowLimit: 100 }, "searchAnalytics.query");
    const fid = all?.metadata?.first_incomplete_date;
    if (isDate(fid)) return { date: addDays(fid, -1), method: "metadata_first_incomplete_date" };
    return { date: null, method: "no_data" };
  }
}
