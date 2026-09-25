// Server-side secrets for the analytics worker. Files live in
// /DATA/AppData/pocketbase-seo-secrets (mounted read-only), never in Git.
// Refresh tokens are AES-256-GCM encrypted by PocketBase ($security.encrypt:
// base64(nonce[12] || ciphertext || tag[16]) with a 32-char key).
import crypto from "node:crypto";
import fs from "node:fs";

export function loadKey(env = process.env) {
  let key = "";
  try { key = fs.readFileSync(env.GSC_KEY_FILE || "/secrets/gsc.key", "utf8").trim(); } catch { key = ""; }
  if (key.length !== 32) throw Object.assign(new Error("Search Console key file missing or invalid"), { code: "SECRETS_UNAVAILABLE" });
  return key;
}

export function loadOAuth(env = process.env) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(env.GOOGLE_OAUTH_FILE || "/secrets/google_oauth.json", "utf8")); } catch { cfg = {}; }
  return { client_id: String(cfg.client_id || ""), client_secret: String(cfg.client_secret || "") };
}

export function decrypt(cipherB64, key) {
  if (!cipherB64) return "";
  const buf = Buffer.from(cipherB64, "base64");
  if (buf.length < 12 + 16) throw Object.assign(new Error("Malformed encrypted secret"), { code: "SECRET_INVALID" });
  const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(key, "utf8"), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString("utf8");
}

export function encrypt(plain, key) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(key, "utf8"), nonce);
  const data = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return Buffer.concat([nonce, data, c.getAuthTag()]).toString("base64");
}
