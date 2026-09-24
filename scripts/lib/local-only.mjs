/**
 * Guard for every test/fixture script that mutates PocketBase.
 *
 * These scripts create and delete records. They must never be able to touch
 * production. A target is accepted only when it is a loopback PocketBase on a
 * port that is NOT the production host port (8096 — pb-seo). Public hostnames
 * (e.g. seo-pb.bunkeragent.cloud) are always refused. There is intentionally no
 * override flag.
 */
export const PRODUCTION_PORTS = Object.freeze(["8096"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function checkLocalTarget(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return { ok: false, reason: `Invalid PB_URL: ${url}` }; }
  if (!LOOPBACK.has(parsed.hostname)) return { ok: false, reason: `Refusing non-loopback PocketBase target ${parsed.host}` };
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  if (PRODUCTION_PORTS.includes(port)) return { ok: false, reason: `Refusing production PocketBase port ${port}` };
  return { ok: true, reason: null };
}

export function assertLocalTarget(url, scriptName = "script") {
  const result = checkLocalTarget(url);
  if (!result.ok) {
    throw new Error(`${scriptName}: ${result.reason}. Test/fixture scripts only run against an ephemeral local PocketBase (e.g. http://127.0.0.1:8097).`);
  }
  return url;
}
