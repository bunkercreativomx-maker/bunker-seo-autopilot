// bunker-seo-content — independent Phase 4 content worker.
// Polls PocketBase content_jobs; never runs inside a Vercel request.
// Secrets (PB superuser, OpenAI, research provider) live only in this process env.
import { createAIProvider } from "./src/ai-provider.js";
import { loadContentConfig } from "./src/config.js";
import { authenticate, claimNextJob, createWorkerClient } from "./src/pb.js";
import { processContentJob, WORKER_VERSION } from "./src/pipeline.js";
import { createResearchProvider } from "./src/research.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Jobs left "running" by a crashed/restarted worker are failed so the user can Retry. */
export async function recoverStaleJobs(pb, { staleMs = 30 * 60_000, now = Date.now(), logger = console } = {}) {
  const running = await pb.collection("content_jobs").getFullList({ filter: 'status = "running"', fields: "id,updated_at,started_at" });
  let recovered = 0;
  for (const job of running) {
    const last = Date.parse(job.updated_at || job.started_at || 0) || 0;
    if (now - last < staleMs) continue;
    await pb.collection("content_jobs").update(job.id, { status: "failed", step: "failed", error: "Worker restarted while job was running; use Retry to continue from the last completed stage.", error_code: "WORKER_RESTART", completed_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() });
    recovered++;
  }
  if (recovered) logger.warn(`[content-worker] recovered ${recovered} stale running job(s)`);
  return recovered;
}

export async function runWorker({ env = process.env, logger = console } = {}) {
  const config = loadContentConfig(env);
  const provider = createAIProvider(config);
  const researchProvider = createResearchProvider(config);
  const pb = await createWorkerClient(env.PB_URL || "http://127.0.0.1:8096");
  await authenticate(pb, env.PB_ADMIN_EMAIL, env.PB_ADMIN_PASSWORD);
  const interval = Math.max(250, Number.parseInt(env.POLL_INTERVAL_MS || "4000", 10));
  const oneShot = env.ONE_SHOT === "1";
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  logger.log(`[content-worker] ${WORKER_VERSION} authenticated; provider=${config.provider} research=${researchProvider.name} models=${JSON.stringify(config.models)} poll=${interval}ms`);
  await recoverStaleJobs(pb, { logger }).catch((e) => logger.error(`[content-worker] stale recovery failed: ${e.message}`));
  do {
    try {
      const job = await claimNextJob(pb);
      if (job) {
        logger.log(`[content-worker] claimed job ${job.id} mode=${job.mode} article=${job.article}`);
        const result = await processContentJob(pb, job, { provider, researchProvider, config, logger });
        logger.log(`[content-worker] job ${job.id} done: ${JSON.stringify({ status: result.status, qa: result.qa_status, calls: result.budget?.calls, tokens: result.budget?.tokens })}`);
      } else if (oneShot) logger.log("[content-worker] no queued jobs");
    } catch (error) {
      logger.error(`[content-worker] ${error?.code || ""} ${error?.message || error}`);
      if (oneShot) throw error;
    }
    if (!oneShot && !stopping) await sleep(interval);
  } while (!oneShot && !stopping);
}

const isEntryPoint = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isEntryPoint) runWorker().catch((error) => { console.error(error); process.exitCode = 1; });
