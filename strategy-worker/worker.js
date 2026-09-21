import { buildStrategy } from "./src/engine.js";
import { createAIProvider, NullAIProvider } from "./src/ai-provider.js";
import { limitsForJob, loadWorkerConfig } from "./src/config.js";
import { discoverKeywordCandidates } from "./src/intelligence.js";
import { authenticate, claimNextJob, createWorkerClient, loadJobInput, updateJob } from "./src/pb.js";
import { persistStrategy, recordAIUsage } from "./src/persist.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NULL_CONFIG = Object.freeze({
  provider: "null",
  retries: 0,
  timeoutMs: 30_000,
  models: { keyword_discovery: "none" },
  limits: { maxAiCalls: 0, maxKeywords: 200, maxClusters: 50, maxOpportunities: 100 },
});

function combineUsage(events) {
  const grouped = new Map();
  for (const event of events) {
    const key = `${event.task}:${event.provider}:${event.model}`;
    const current = grouped.get(key) || { ...event, calls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
    current.calls += Number(event.calls) || 0;
    current.inputTokens += Number(event.inputTokens) || 0;
    current.outputTokens += Number(event.outputTokens) || 0;
    current.estimatedCost += Number(event.estimatedCost) || 0;
    grouped.set(key, current);
  }
  return [...grouped.values()];
}

export async function processStrategyJob(pb, job, { provider = new NullAIProvider(), config = NULL_CONFIG, now = () => new Date().toISOString() } = {}) {
  let context;
  const usageEvents = [];
  let pendingUsage = [];
  let usagePersistenceComplete = false;
  try {
    context = await loadJobInput(pb, job);
    context.job = job;
    const limits = limitsForJob(config, job.configuration || {});
    await updateJob(pb, job.id, { step: "discovering_keywords", progress: 25 });
    const discovery = await discoverKeywordCandidates(context, {
      provider,
      config,
      limits,
      onUsage: (usage) => usageEvents.push(usage),
    });
    const usage = combineUsage(usageEvents);
    pendingUsage = [...usage];
    const strategy = buildStrategy({
      ...context,
      limits,
      ai_candidates: discovery.candidates,
      ai: { provider: provider.name || "unknown", calls: usage.reduce((sum, item) => sum + item.calls, 0) },
    });
    await updateJob(pb, job.id, { step: "persisting_strategy", progress: 75 });
    const saved = await persistStrategy(pb, strategy, context, undefined, now());
    context.savedVersionId = saved.version.id;
    while (pendingUsage.length) {
      await recordAIUsage(pb, pendingUsage[0], context);
      pendingUsage.shift();
    }
    usagePersistenceComplete = true;
    await updateJob(pb, job.id, {
      status: "completed",
      step: "completed",
      progress: 100,
      completed_at: now(),
    });
    return strategy;
  } catch (error) {
    if (context) {
      if (!usagePersistenceComplete && !pendingUsage.length && usageEvents.length) pendingUsage = combineUsage(usageEvents);
      for (const item of pendingUsage) {
        await recordAIUsage(pb, item, context).catch(() => {});
      }
    }
    await updateJob(pb, job.id, { status: "failed", step: "failed", error: String(error?.message || error).slice(0, 1000), completed_at: now() });
    throw error;
  }
}

export async function runWorker({ env = process.env, logger = console } = {}) {
  const config = loadWorkerConfig(env);
  const provider = createAIProvider(config);
  const pb = await createWorkerClient(env.PB_URL || "http://127.0.0.1:8096");
  await authenticate(pb, env.PB_ADMIN_EMAIL, env.PB_ADMIN_PASSWORD);
  const interval = Math.max(250, Number.parseInt(env.POLL_INTERVAL_MS || "3000", 10));
  const oneShot = env.ONE_SHOT === "1";
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  logger.log(`[strategy-worker] authenticated; provider=${config.provider} model=${config.models.keyword_discovery} poll=${interval}ms`);
  do {
    try {
      const job = await claimNextJob(pb);
      if (job) {
        await processStrategyJob(pb, job, { provider, config });
        logger.log(`[strategy-worker] completed job ${job.id}`);
      } else if (oneShot) logger.log("[strategy-worker] no queued jobs");
    } catch (error) {
      logger.error(`[strategy-worker] ${error?.message || error}`);
      if (oneShot) throw error;
    }
    if (!oneShot && !stopping) await sleep(interval);
  } while (!oneShot && !stopping);
}

const isEntryPoint = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isEntryPoint) runWorker().catch((error) => { console.error(error); process.exitCode = 1; });
