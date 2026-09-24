// HMAC request signing shared by the worker (signer) and target websites
// (verifier). Signature = HMAC-SHA256(secret, `${timestamp}.${nonce}.${body}`).
// Replay protection: timestamp window + single-use nonce (caller-provided store).
import crypto from "node:crypto";

export const HEADERS = { timestamp: "x-bunker-timestamp", nonce: "x-bunker-nonce", signature: "x-bunker-signature", website: "x-bunker-website" };
export const DEFAULT_WINDOW_S = 300;

export function sign(secret, body, { timestamp = Math.floor(Date.now() / 1000), nonce = crypto.randomUUID() } = {}) {
  const mac = crypto.createHmac("sha256", secret).update(`${timestamp}.${nonce}.${body}`).digest("hex");
  return { [HEADERS.timestamp]: String(timestamp), [HEADERS.nonce]: nonce, [HEADERS.signature]: `v1=${mac}` };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Verify a signed request. `secrets` = [current, previous?] (rotation).
 * `nonceStore` must implement `seen(nonce): boolean|Promise` and `remember(nonce, ttlS)`.
 * Returns { ok: true } or { ok: false, code }.
 */
export async function verify({ secrets, body, headers, nonceStore, windowS = DEFAULT_WINDOW_S, now = Math.floor(Date.now() / 1000) }) {
  const get = (h) => (typeof headers.get === "function" ? headers.get(h) : headers[h]) || "";
  const ts = Number(get(HEADERS.timestamp));
  const nonce = String(get(HEADERS.nonce));
  const sig = String(get(HEADERS.signature));
  if (!ts || !nonce || !sig.startsWith("v1=")) return { ok: false, code: "SIGNATURE_MISSING" };
  if (!/^[A-Za-z0-9-]{8,100}$/.test(nonce)) return { ok: false, code: "SIGNATURE_INVALID" };
  if (Math.abs(now - ts) > windowS) return { ok: false, code: "SIGNATURE_EXPIRED" };
  const list = (secrets || []).filter(Boolean);
  if (!list.length) return { ok: false, code: "NOT_CONFIGURED" };
  const valid = list.some((s) => safeEqual(sig, `v1=${crypto.createHmac("sha256", s).update(`${ts}.${nonce}.${body}`).digest("hex")}`));
  if (!valid) return { ok: false, code: "SIGNATURE_INVALID" };
  if (nonceStore) {
    if (await nonceStore.seen(nonce)) return { ok: false, code: "REPLAY" };
    await nonceStore.remember(nonce, windowS * 2);
  }
  return { ok: true };
}

export function memoryNonceStore() {
  const m = new Map();
  return {
    seen(n) { const t = m.get(n); return Boolean(t && t > Date.now()); },
    remember(n, ttl) { m.set(n, Date.now() + ttl * 1000); if (m.size > 10000) for (const [k, v] of m) if (v < Date.now()) m.delete(k); },
  };
}
