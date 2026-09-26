// bunker-seo-autopilot — independent Phase 7 orchestration worker.
// Coordinates existing workflows only (crawl/strategy/content/publish jobs are
// executed by their own workers). Superuser credentials live only in this
// container's env; nothing runs inside Vercel. Logs never print secrets.
import PocketBase from "pocketbase";
import { hostname } from "node:os";
import { Engine, WORKER_VERSION } from "./src/engine.js";
import { telegramFromEnv } from "./src/telegram.js";
import { falFromEnv } from "./src/images.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runWorker({ env = process.env, logger = console } = {}) {
  const pb = new PocketBase(env.PB_URL || "http://127.0.0.1:8096");
  pb.autoCancellation(false);
  if (!env.PB_ADMIN_EMAIL || !env.PB_ADMIN_PASSWORD) throw new Error("PB_ADMIN_EMAIL and PB_ADMIN_PASSWORD are required");
  await pb.collection("_superusers").authWithPassword(env.PB_ADMIN_EMAIL, env.PB_ADMIN_PASSWORD);
  const interval = Math.max(1000, Number.parseInt(env.POLL_INTERVAL_MS || "15000", 10));
  const oneShot = env.ONE_SHOT === "1";
  const workerId = `${hostname()}-${process.pid}`;
  const telegram = telegramFromEnv(env, { logger });
  const images = falFromEnv(env, { logger });
  const engine = new Engine(pb, { logger, workerId, telegram, images, appUrl: env.APP_URL || "" });
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  logger.log(`[autopilot] ${WORKER_VERSION} authenticated; poll=${interval}ms id=${workerId} telegram=${telegram ? "on" : "off"} images=${images ? "on" : "off"}`);
  let lastAuth = Date.now();
  let lastBeat = 0;
  do {
    try {
      if (Date.now() - lastAuth > 6 * 3600_000) { await pb.collection("_superusers").authRefresh(); lastAuth = Date.now(); }
      if (Date.now() - lastBeat > 60_000) { lastBeat = Date.now(); await engine.heartbeat({ poll_ms: interval }); }
      await engine.tick();
    } catch (e) {
      logger.error(`[autopilot] loop error ${e?.status || ""} ${String(e?.response?.code || e?.code || "")} ${String(e?.message || e).slice(0, 300)}`);
      if (oneShot) throw e;
    }
    if (!oneShot && !stopping) await sleep(interval);
  } while (!oneShot && !stopping);
}

const isEntry = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isEntry) runWorker().catch((e) => { console.error(`[autopilot] fatal ${e?.message || e}`); process.exitCode = 1; });
