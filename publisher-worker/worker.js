// bunker-seo-publisher — independent Phase 5 publishing worker.
// Polls PocketBase publish_jobs; never runs inside a Vercel request.
// Secrets (PB superuser, publishing encryption key) live only in this process.
import PocketBase from "pocketbase";
import { claimNextJob, processJob, recoverStale, WORKER_VERSION } from "./src/engine.js";
import { loadKey } from "./src/secrets.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runWorker({ env = process.env, logger = console } = {}) {
  const pb = new PocketBase(env.PB_URL || "http://127.0.0.1:8096");
  pb.autoCancellation(false);
  if (!env.PB_ADMIN_EMAIL || !env.PB_ADMIN_PASSWORD) throw new Error("PB_ADMIN_EMAIL and PB_ADMIN_PASSWORD are required");
  await pb.collection("_superusers").authWithPassword(env.PB_ADMIN_EMAIL, env.PB_ADMIN_PASSWORD);
  const key = loadKey(env);
  const interval = Math.max(250, Number.parseInt(env.POLL_INTERVAL_MS || "3000", 10));
  const oneShot = env.ONE_SHOT === "1";
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  logger.log(`[publisher] ${WORKER_VERSION} authenticated; poll=${interval}ms`);
  await recoverStale(pb, { logger }).catch((e) => logger.error(`[publisher] stale recovery failed: ${e.message}`));
  let lastAuth = Date.now();
  do {
    try {
      if (Date.now() - lastAuth > 6 * 3600_000) { await pb.collection("_superusers").authRefresh(); lastAuth = Date.now(); }
      const job = await claimNextJob(pb);
      if (job) await processJob(pb, job, { env, key, logger });
      else if (oneShot) logger.log("[publisher] no queued jobs");
    } catch (e) {
      logger.error(`[publisher] loop error ${e?.code || ""} ${String(e?.message || e).slice(0, 300)}`);
      if (oneShot) throw e;
    }
    if (!oneShot && !stopping) await sleep(interval);
  } while (!oneShot && !stopping);
}

const isEntry = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isEntry) runWorker().catch((e) => { console.error(`[publisher] fatal ${e?.message || e}`); process.exitCode = 1; });
