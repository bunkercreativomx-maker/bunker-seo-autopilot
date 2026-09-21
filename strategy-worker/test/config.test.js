import test from "node:test";
import assert from "node:assert/strict";
import { limitsForJob, loadWorkerConfig } from "../src/config.js";

test("defaults to null provider with bounded budgets", () => {
  const config = loadWorkerConfig({});
  assert.equal(config.provider, "null");
  assert.equal(config.limits.maxAiCalls, 4);
  assert.equal(config.limits.maxKeywords, 200);
});

test("openai requires a key and supports per-task model routing", () => {
  assert.throws(() => loadWorkerConfig({ AI_PROVIDER: "openai" }), /OPENAI_API_KEY/);
  const config = loadWorkerConfig({ AI_PROVIDER: "openai", OPENAI_API_KEY: "secret", AI_MODEL: "base", AI_MODEL_KEYWORD_DISCOVERY: "discover" });
  assert.equal(config.models.keyword_discovery, "discover");
});

test("rejects invalid and excessive environment budgets", () => {
  assert.throws(() => loadWorkerConfig({ MAX_AI_CALLS_PER_STRATEGY: "999" }), /MAX_AI_CALLS/);
  assert.throws(() => loadWorkerConfig({ AI_TIMEOUT_MS: "5" }), /AI_TIMEOUT_MS/);
  assert.throws(() => loadWorkerConfig({ AI_PROVIDER: "bogus" }), /AI_PROVIDER/);
});

test("job budgets can lower but never raise operator limits", () => {
  const config = loadWorkerConfig({ MAX_AI_CALLS_PER_STRATEGY: "3", MAX_KEYWORDS_PER_STRATEGY: "100", MAX_CLUSTERS: "20", MAX_OPPORTUNITIES: "40" });
  assert.deepEqual(limitsForJob(config, {
    max_ai_calls_per_strategy: 999,
    max_keywords_per_strategy: 10,
    max_clusters: 30,
    max_opportunities: 0,
  }), { maxAiCalls: 3, maxKeywords: 10, maxClusters: 20, maxOpportunities: 0 });
});
