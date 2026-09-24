// Outbound HTTP for publishing: SSRF-checked, allowlisted per integration,
// no automatic redirects to other hosts, bounded time and size.
import dns from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import { ssrfCheck, isPublicIp } from "./ssrf.js";

// Connect-time pinning: the socket may ONLY connect to addresses that pass
// isPublicIp at the moment of connection. This closes the DNS-rebinding gap
// between the pre-flight ssrfCheck and the actual TCP connect. Public DNS
// resolvers (container resolv.conf) are only used to RESOLVE; every resolved
// address is still validated here.
export function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, records) => {
    if (err) return callback(Object.assign(new Error(`DNS resolution failed for ${hostname}`), { code: "DNS_FAILED" }));
    if (!records?.length) return callback(Object.assign(new Error(`No addresses for ${hostname}`), { code: "DNS_FAILED" }));
    if (records.some((r) => !isPublicIp(r.address, r.family))) return callback(Object.assign(new Error("Blocked private/special address"), { code: "SSRF_BLOCKED" }));
    if (options && options.all) return callback(null, records);
    return callback(null, records[0].address, records[0].family);
  });
}
const pinnedAgent = new Agent({ connect: { lookup: safeLookup, timeout: 10000 } });
const plainAgent = new Agent({ connect: { timeout: 10000 } });

export class PublishError extends Error {
  constructor(code, message, { retryable = false, status = 0 } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

function privateAllowlist(env = process.env) {
  return String(env.BSA_PUBLISH_PRIVATE_ALLOWLIST || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
}

/** Destination policy: host must be in the integration's allowed domains AND public (SSRF). */
export async function checkDestination(url, allowedDomains, env = process.env) {
  let u;
  try { u = new URL(url); } catch { throw new PublishError("INVALID_TARGET", "Invalid destination URL"); }
  if (u.username || u.password) throw new PublishError("INVALID_TARGET", "Credentials in URL are not allowed");
  const host = u.hostname.toLowerCase();
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const allowed = (allowedDomains || []).map((d) => String(d).toLowerCase());
  if (!allowed.includes(host)) throw new PublishError("DOMAIN_NOT_ALLOWED", `Destination host ${host} is not allowlisted for this website`);
  if (privateAllowlist(env).includes(`${host}:${port}`)) { u.__sandbox = true; return u; } // local test sandbox only
  if (u.protocol !== "https:") throw new PublishError("INVALID_TARGET", "Destination must use https");
  const r = await ssrfCheck(u.toString());
  if (!r.ok) {
    // Fail closed either way; only the reported code differs.
    if (/DNS resolution failed|No addresses/.test(String(r.reason || ""))) throw new PublishError("DNS_FAILED", `Destination host ${host} could not be resolved`);
    throw new PublishError("SSRF_BLOCKED", "Destination resolves to a private or blocked address");
  }
  return u;
}

export async function request(url, { method = "GET", headers = {}, body, allowedDomains, timeoutMs = 15000, maxBytes = 3_000_000, env = process.env } = {}) {
  let current = await checkDestination(url, allowedDomains, env);
  for (let hop = 0; hop <= 3; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await undiciFetch(current.toString(), { method, headers: { "user-agent": "BunkerSEO-Publisher/0.5 (+https://bunkeragent.cloud)", ...headers }, body, redirect: "manual", signal: ctrl.signal, dispatcher: current.__sandbox ? plainAgent : pinnedAgent });
    } catch (e) {
      clearTimeout(timer);
      const code = e?.cause?.code || e?.code;
      if (code === "SSRF_BLOCKED") throw new PublishError("SSRF_BLOCKED", "Destination resolves to a private or blocked address");
      if (code === "DNS_FAILED") throw new PublishError("DNS_FAILED", "Destination host could not be resolved", { retryable: true });
      if (e?.name === "AbortError") throw new PublishError("TIMEOUT", "The target website did not respond in time", { retryable: true });
      throw new PublishError("NETWORK_ERROR", "Could not reach the target website", { retryable: true });
    }
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get("location")) {
      clearTimeout(timer);
      if (method !== "GET") throw new PublishError("UNEXPECTED_REDIRECT", "The publishing endpoint redirected; configure the final URL");
      current = await checkDestination(new URL(res.headers.get("location"), current).toString(), allowedDomains, env);
      continue;
    }
    const reader = res.body?.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) { ctrl.abort(); throw new PublishError("RESPONSE_TOO_LARGE", "Response exceeded the size limit"); }
        chunks.push(value);
      }
    } catch (e) {
      if (e instanceof PublishError) throw e;
      if (e?.name === "AbortError") throw new PublishError("TIMEOUT", "The target website did not respond in time", { retryable: true });
      throw new PublishError("NETWORK_ERROR", "Connection interrupted", { retryable: true });
    } finally {
      clearTimeout(timer);
    }
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    return { status: res.status, headers: res.headers, text, url: current.toString(), json() { try { return JSON.parse(text); } catch { return null; } } };
  }
  throw new PublishError("TOO_MANY_REDIRECTS", "Too many redirects");
}

/** Map an HTTP status to a safe error for connection tests / publish calls. */
export function httpError(status, what = "Target") {
  if (status === 401 || status === 403) return new PublishError("UNAUTHORIZED", `${what} rejected the credentials (${status})`, { status });
  if (status === 404) return new PublishError("NOT_FOUND", `${what} endpoint not found (404)`, { status });
  if (status === 409) return new PublishError("SLUG_CONFLICT", `${what} reported a slug conflict (409)`, { status });
  if (status === 429 || status >= 500) return new PublishError("TARGET_UNAVAILABLE", `${what} is unavailable (${status})`, { status, retryable: true });
  return new PublishError("INVALID_RESPONSE", `${what} returned an unexpected status (${status})`, { status });
}
