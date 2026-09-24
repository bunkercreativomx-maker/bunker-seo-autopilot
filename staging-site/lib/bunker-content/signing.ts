import "server-only";
import crypto from "node:crypto";

export const HEADERS = { timestamp: "x-bunker-timestamp", nonce: "x-bunker-nonce", signature: "x-bunker-signature", website: "x-bunker-website" } as const;
const WINDOW_S = 300;

type NonceStore = { seen(n: string): boolean | Promise<boolean>; remember(n: string, ttlS: number): void | Promise<void> };

const memory = new Map<string, number>();
export const memoryNonceStore: NonceStore = {
  seen: (n) => Boolean((memory.get(n) ?? 0) > Date.now()),
  remember: (n, ttl) => {
    memory.set(n, Date.now() + ttl * 1000);
    if (memory.size > 5000) for (const [k, v] of memory) if (v < Date.now()) memory.delete(k);
  },
};

function equal(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** HMAC-SHA256(secret, `${ts}.${nonce}.${rawBody}`), ±5 min window, single-use nonce. */
export async function verifySignature(headers: Headers, rawBody: string, secrets: string[], nonces: NonceStore) {
  const ts = Number(headers.get(HEADERS.timestamp));
  const nonce = headers.get(HEADERS.nonce) ?? "";
  const sig = headers.get(HEADERS.signature) ?? "";
  if (!ts || !nonce || !sig.startsWith("v1=")) return { ok: false as const, code: "SIGNATURE_MISSING" };
  if (!/^[A-Za-z0-9-]{8,100}$/.test(nonce)) return { ok: false as const, code: "SIGNATURE_INVALID" };
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > WINDOW_S) return { ok: false as const, code: "SIGNATURE_EXPIRED" };
  if (!secrets.length) return { ok: false as const, code: "NOT_CONFIGURED" };
  const valid = secrets.some((s) => equal(sig, `v1=${crypto.createHmac("sha256", s).update(`${ts}.${nonce}.${rawBody}`).digest("hex")}`));
  if (!valid) return { ok: false as const, code: "SIGNATURE_INVALID" };
  if (await nonces.seen(nonce)) return { ok: false as const, code: "REPLAY" };
  await nonces.remember(nonce, WINDOW_S * 2);
  return { ok: true as const };
}

/** Simple fixed-window limiter per client IP (defense in depth; signatures are the real gate). */
const hits = new Map<string, { n: number; reset: number }>();
export function rateLimited(ip: string, limit = 60, windowMs = 60_000) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.reset < now) { hits.set(ip, { n: 1, reset: now + windowMs }); return false; }
  h.n++;
  return h.n > limit;
}
