// bunker-seo-analytics — independent Phase 6 Search Console worker.
// Polls gsc_sync_jobs and schedules one daily sync per connected property.
// Google credentials and the token key live only in this process (files
// mounted read-only); nothing runs inside Vercel.
import PocketBase from "pocketbase";
import { claimNextJob, processJob, recoverStale, scheduleDaily, WORKER_VERSION } from "./src/engine.js";
import { loadKey, loadOAuth } from "./src/secrets.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runWorker({ env = process.env, logger = console } = {}) {
  const pb = new PocketBase(env.PB_URL || "http://127.0.0.1:8096");
  pb.autoCancellation(false);
  if (!env.PB_ADMIN_EMAIL || !env.PB_ADMIN_PASSWORD) throw new Error("PB_ADMIN_EMAIL and PB_ADMIN_PASSWORD are required");
  await pb.collection("_superusers").authWithPassword(env.PB_ADMIN_EMAIL, env.PB_ADMIN_PASSWORD);
  const key = loadKey(env);
  const interval = Math.max(500, Number.parseInt(env.POLL_INTERVAL_MS || "5000", 10));
  const hourUtc = Number.parseInt(env.DAILY_SYNC_HOUR_UTC || "10", 10);
  const oneShot = env.ONE_SHOT === "1";
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  const oauth = loadOAuth(env);
  logger.log(`[analytics] ${WORKER_VERSION} authenticated; poll=${interval}ms daily>=${hourUtc}:00Z oauth=${oauth.client_id ? "configured" : "missing"}`);
  await recoverStale(pb, { logger }).catch((e) => logger.error(`[analytics] stale recovery failed: ${e.message}`));
  let lastAuth = Date.now();
  let lastSchedule = 0;
  do {
    try {
      if (Date.now() - lastAuth > 6 * 3600_000) { await pb.collection("_superusers").authRefresh(); lastAuth = Date.now(); }
      if (!oneShot && Date.now() - lastSchedule > 10 * 60_000) { lastSchedule = Date.now(); await scheduleDaily(pb, { hourUtc, logger }); }
      const job = await claimNextJob(pb);
      // OAuth client config is re-read per job so a rotated secret needs no restart.
      if (job) await processJob(pb, job, { env, key, oauth: loadOAuth(env), logger });
      else if (oneShot) logger.log("[analytics] no queued jobs");
    } catch (e) {
      logger.error(`[analytics] loop error ${e?.code || ""} ${String(e?.message || e).slice(0, 300)}`);
      if (oneShot) throw e;
    }
    if (!oneShot && !stopping) await sleep(interval);
  } while (!oneShot && !stopping);
}

const isEntry = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isEntry) runWorker().catch((e) => { console.error(`[analytics] fatal ${e?.message || e}`); process.exitCode = 1; });
