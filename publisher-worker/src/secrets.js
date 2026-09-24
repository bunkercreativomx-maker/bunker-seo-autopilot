// Decrypts integration secrets written by PocketBase $security.encrypt
// (AES-256-GCM, base64(nonce[12] || ciphertext || tag[16]), 32-char key).
// The key lives in a file outside the database and outside Git.
import crypto from "node:crypto";
import fs from "node:fs";

export function loadKey(env = process.env) {
  const path = env.PUBLISHING_KEY_FILE || "/pb_secrets/publishing.key";
  let key = "";
  try { key = fs.readFileSync(path, "utf8").trim(); } catch { key = ""; }
  if (key.length !== 32) throw Object.assign(new Error("Publishing key file missing or invalid"), { code: "SECRETS_UNAVAILABLE" });
  return key;
}

export function decrypt(cipherB64, key) {
  if (!cipherB64) return "";
  const buf = Buffer.from(cipherB64, "base64");
  if (buf.length < 12 + 16) throw Object.assign(new Error("Malformed encrypted secret"), { code: "SECRET_INVALID" });
  const nonce = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const data = buf.subarray(12, buf.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(key, "utf8"), nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

export function encrypt(plain, key) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(key, "utf8"), nonce);
  const data = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return Buffer.concat([nonce, data, c.getAuthTag()]).toString("base64");
}

/** Current secret plus the previous one while its rotation grace window is open. */
export function secretsOf(integration, key, now = Date.now()) {
  const out = [];
  if (integration?.secret_encrypted) out.push(decrypt(integration.secret_encrypted, key));
  const until = Date.parse(integration?.previous_secret_valid_until || "") || 0;
  if (integration?.previous_secret_encrypted && until > now) out.push(decrypt(integration.previous_secret_encrypted, key));
  return out;
}
