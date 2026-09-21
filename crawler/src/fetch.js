// Safe HTTP fetch used by the crawler.
// Guarantees: per-hop SSRF revalidation, request timeout, max redirects,
// max response size, retry with backoff, identifiable user-agent.
import { ssrfCheck, ssrfCheckRedirect } from "./ssrf.js";

export const CRAWLER_UA =
  "Mozilla/5.0 (compatible; BunkerSEOCrawler/0.2; +https://bunkeragent.cloud/seo-crawler)";

// Config baked from worker defaults; callers can override via options.
export const DEFAULTS = {
  timeoutMs: 15000,
  maxRedirects: 5,
  maxPageSizeBytes: 2 * 1024 * 1024, // 2 MB
  maxRetries: 2,
  retryDelayMs: 800,
};

/**
 * Fetch a URL with all safety guarantees. Returns a normalized result object:
 * { url, finalUrl, status, ok, redirected, redirects: [...], headers, size, body, html, ssrfBlocked, error }
 * Throws only on catastrophic local failure; network/HTTP errors come back in the result.
 */
export async function safeFetch(inputUrl, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const userAgent = opts.userAgent || cfg.userAgent || CRAWLER_UA;

  // --- initial SSRF gate ---
  const gate = await ssrfCheck(inputUrl);
  if (!gate.ok) {
    return { url: inputUrl, finalUrl: inputUrl, status: 0, ok: false, ssrfBlocked: true, error: gate.reason, redirects: [] };
  }

  let current = inputUrl;
  const redirects = [];
  let finalStatus = 0;
  let redirectChain = [];
  let lastHeaders = {};
  let lastSize = 0;

  for (let hop = 0; hop <= cfg.maxRedirects; hop++) {
    // per-hop SSRF (first hop already validated, but re-check cheaply for safety)
    const hopGate = await ssrfCheck(current);
    if (!hopGate.ok) {
      return { url: inputUrl, finalUrl: current, status: 0, ok: false, ssrfBlocked: true, error: hopGate.reason, redirects: redirectChain };
    }

    for (let attemptNo = 0; attemptNo <= cfg.maxRetries; attemptNo++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      try {
        const resp = await fetch(current, {
          redirect: "manual", // we control redirects to revalidate SSRF
          signal: controller.signal,
          headers: {
            "User-Agent": userAgent,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
        });
        clearTimeout(timer);
        finalStatus = resp.status;
        lastHeaders = Object.fromEntries(resp.headers.entries());

        // Redirect hop?
        if (resp.status >= 300 && resp.status < 400 && resp.headers.get("location")) {
          const loc = resp.headers.get("location");
          let next;
          try {
            next = new URL(loc, current).toString();
          } catch {
            return { url: inputUrl, finalUrl: current, status: resp.status, ok: false, error: "Invalid redirect location", redirects: redirectChain, headers: lastHeaders };
          }
          redirectChain.push({ from: current, to: next, status: resp.status });
          // Revalidate SSRF for next hop BEFORE following
          const nextGate = await ssrfCheckRedirect(next);
          if (!nextGate.ok) {
            return { url: inputUrl, finalUrl: next, status: resp.status, ok: false, ssrfBlocked: true, error: `Redirect to blocked target: ${nextGate.reason}`, redirects: redirectChain, headers: lastHeaders };
          }
          current = next;
          redirects.push(next);
          // continue outer loop
          break;
        }

        // Non-redirect: read body with size cap.
        const contentLength = parseInt(resp.headers.get("content-length") || "0", 10);
        if (contentLength > cfg.maxPageSizeBytes) {
          return { url: inputUrl, finalUrl: current, status: resp.status, ok: true, truncated: true, headers: lastHeaders, redirects: redirectChain, size: contentLength, body: null };
        }
        const reader = resp.body.getReader();
        const chunks = [];
        let total = 0;
        let truncated = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > cfg.maxPageSizeBytes) { truncated = true; break; }
          chunks.push(value);
        }
        const buf = Buffer.concat(chunks);
        lastSize = buf.length;
        await resp.body?.cancel?.().catch(() => {});
        return {
          url: inputUrl,
          finalUrl: current,
          status: finalStatus,
          ok: finalStatus >= 200 && finalStatus < 300,
          redirects: redirectChain,
          headers: lastHeaders,
          size: lastSize,
          truncated,
          body: buf,
          html: buf.toString("utf-8"),
        };
      } catch (e) {
        clearTimeout(timer);
        const isAbort = e?.name === "AbortError";
        const msg = isAbort ? "Request timeout" : (e?.message || String(e));
        if (attemptNo < cfg.maxRetries) {
          await sleep(cfg.retryDelayMs * (attemptNo + 1));
          continue;
        }
        return { url: inputUrl, finalUrl: current, status: 0, ok: false, error: msg, redirects: redirectChain };
      }
    }
  }

  return { url: inputUrl, finalUrl: current, status: finalStatus, ok: false, error: "Too many redirects", redirects: redirectChain, headers: lastHeaders };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}