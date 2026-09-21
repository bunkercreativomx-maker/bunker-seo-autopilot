const HARD_LIMITS = Object.freeze({
  aiCalls: 20,
  keywords: 1_000,
  clusters: 200,
  opportunities: 500,
  timeoutMs: 120_000,
  retries: 3,
});

function integer(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, name } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name || "value"} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function finiteNumber(value, fallback, { min = 0, name } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) throw new Error(`${name || "value"} must be a finite number >= ${min}`);
  return parsed;
}

function requestedLimit(configuration, key, maximum) {
  const requested = configuration?.[key];
  if (requested === undefined || requested === null || requested === "") return maximum;
  return Math.min(integer(requested, maximum, { min: 0, max: Number.MAX_SAFE_INTEGER, name: `configuration.${key}` }), maximum);
}

export function loadWorkerConfig(env = process.env) {
  const provider = String(env.AI_PROVIDER || "null").trim().toLowerCase();
  if (!new Set(["null", "openai"]).has(provider)) throw new Error('AI_PROVIDER must be "openai" or "null"');
  if (provider === "openai" && !env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required when AI_PROVIDER=openai");

  const model = String(env.AI_MODEL || "gpt-5-mini").trim();
  const models = { keyword_discovery: String(env.AI_MODEL_KEYWORD_DISCOVERY || model).trim() };
  if (!models.keyword_discovery) throw new Error("AI model names cannot be empty");

  return Object.freeze({
    provider,
    apiKey: provider === "openai" ? env.OPENAI_API_KEY : undefined,
    baseUrl: String(env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    model,
    models,
    retries: integer(env.AI_MAX_RETRIES, 2, { min: 0, max: HARD_LIMITS.retries, name: "AI_MAX_RETRIES" }),
    timeoutMs: integer(env.AI_TIMEOUT_MS, 30_000, { min: 1_000, max: HARD_LIMITS.timeoutMs, name: "AI_TIMEOUT_MS" }),
    limits: Object.freeze({
      maxAiCalls: integer(env.MAX_AI_CALLS_PER_STRATEGY, 4, { min: 0, max: HARD_LIMITS.aiCalls, name: "MAX_AI_CALLS_PER_STRATEGY" }),
      maxKeywords: integer(env.MAX_KEYWORDS_PER_STRATEGY, 200, { min: 1, max: HARD_LIMITS.keywords, name: "MAX_KEYWORDS_PER_STRATEGY" }),
      maxClusters: integer(env.MAX_CLUSTERS, 50, { min: 1, max: HARD_LIMITS.clusters, name: "MAX_CLUSTERS" }),
      maxOpportunities: integer(env.MAX_OPPORTUNITIES, 100, { min: 0, max: HARD_LIMITS.opportunities, name: "MAX_OPPORTUNITIES" }),
    }),
    pricing: Object.freeze({
      inputPerMillion: finiteNumber(env.OPENAI_INPUT_COST_PER_MILLION, 0, { name: "OPENAI_INPUT_COST_PER_MILLION" }),
      outputPerMillion: finiteNumber(env.OPENAI_OUTPUT_COST_PER_MILLION, 0, { name: "OPENAI_OUTPUT_COST_PER_MILLION" }),
    }),
  });
}

export function limitsForJob(config, configuration = {}) {
  return Object.freeze({
    maxAiCalls: requestedLimit(configuration, "max_ai_calls_per_strategy", config.limits.maxAiCalls),
    maxKeywords: requestedLimit(configuration, "max_keywords_per_strategy", config.limits.maxKeywords),
    maxClusters: requestedLimit(configuration, "max_clusters", config.limits.maxClusters),
    maxOpportunities: requestedLimit(configuration, "max_opportunities", config.limits.maxOpportunities),
  });
}
