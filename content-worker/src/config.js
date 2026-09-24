// Content-worker configuration. Everything is env-driven; no model is hard-coded
// globally. Each pipeline task routes to its own model with sensible fallbacks.

export const CONTENT_TASKS = Object.freeze([
  "research_analysis",
  "brief_generation",
  "outline_generation",
  "draft_generation",
  "claim_extraction",
  "fact_check",
  "qa",
  "revision",
  "metadata",
]);

const HARD_LIMITS = Object.freeze({
  aiCalls: 60,
  revisionCycles: 5,
  researchSources: 20,
  totalTokens: 3_000_000,
  timeoutMs: 600_000,
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

function text(value, fallback) {
  const out = String(value ?? "").trim();
  return out || fallback;
}

export function loadContentConfig(env = process.env) {
  const provider = text(env.AI_PROVIDER, "null").toLowerCase();
  if (!new Set(["null", "openai"]).has(provider)) throw new Error('AI_PROVIDER must be "openai" or "null"');
  if (provider === "openai" && !env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required when AI_PROVIDER=openai");

  const base = text(env.AI_MODEL, "gpt-5-mini");
  const research = text(env.RESEARCH_MODEL, base);
  const brief = text(env.BRIEF_MODEL, base);
  const writer = text(env.WRITER_MODEL, base);
  const factCheck = text(env.FACT_CHECK_MODEL, base);
  const qa = text(env.QA_MODEL, base);
  const models = Object.freeze({
    research_analysis: research,
    brief_generation: brief,
    outline_generation: text(env.OUTLINE_MODEL, brief),
    draft_generation: writer,
    revision: text(env.REVISION_MODEL, writer),
    metadata: text(env.METADATA_MODEL, brief),
    claim_extraction: text(env.CLAIM_MODEL, factCheck),
    fact_check: factCheck,
    qa,
  });

  const researchProvider = text(env.RESEARCH_PROVIDER, "none").toLowerCase();
  if (!new Set(["none", "firecrawl"]).has(researchProvider)) throw new Error('RESEARCH_PROVIDER must be "firecrawl" or "none"');
  if (researchProvider === "firecrawl" && !env.FIRECRAWL_API_KEY) throw new Error("FIRECRAWL_API_KEY is required when RESEARCH_PROVIDER=firecrawl");

  return Object.freeze({
    provider,
    apiKey: provider === "openai" ? env.OPENAI_API_KEY : undefined,
    baseUrl: text(env.OPENAI_BASE_URL, "https://api.openai.com/v1").replace(/\/+$/, ""),
    models,
    retries: integer(env.AI_MAX_RETRIES, 1, { min: 0, max: HARD_LIMITS.retries, name: "AI_MAX_RETRIES" }),
    timeoutMs: integer(env.AI_TIMEOUT_MS, 90_000, { min: 1_000, max: HARD_LIMITS.timeoutMs, name: "AI_TIMEOUT_MS" }),
    writerTimeoutMs: integer(env.WRITER_TIMEOUT_MS, 240_000, { min: 1_000, max: HARD_LIMITS.timeoutMs, name: "WRITER_TIMEOUT_MS" }),
    research: Object.freeze({
      provider: researchProvider,
      apiKey: researchProvider === "firecrawl" ? env.FIRECRAWL_API_KEY : undefined,
      baseUrl: text(env.FIRECRAWL_BASE_URL, "https://api.firecrawl.dev/v1").replace(/\/+$/, ""),
      timeoutMs: integer(env.RESEARCH_TIMEOUT_MS, 30_000, { min: 1_000, max: 120_000, name: "RESEARCH_TIMEOUT_MS" }),
    }),
    limits: Object.freeze({
      maxAiCalls: integer(env.MAX_AI_CALLS_PER_ARTICLE, 24, { min: 0, max: HARD_LIMITS.aiCalls, name: "MAX_AI_CALLS_PER_ARTICLE" }),
      maxRevisionCycles: integer(env.MAX_REVISION_CYCLES, 2, { min: 0, max: HARD_LIMITS.revisionCycles, name: "MAX_REVISION_CYCLES" }),
      maxResearchSources: integer(env.MAX_RESEARCH_SOURCES, 8, { min: 0, max: HARD_LIMITS.researchSources, name: "MAX_RESEARCH_SOURCES" }),
      maxTotalTokens: integer(env.MAX_TOKENS_PER_ARTICLE, 600_000, { min: 1_000, max: HARD_LIMITS.totalTokens, name: "MAX_TOKENS_PER_ARTICLE" }),
      maxBudgetUsd: finiteNumber(env.MAX_BUDGET_USD_PER_ARTICLE, 0, { name: "MAX_BUDGET_USD_PER_ARTICLE" }),
    }),
    pricing: Object.freeze({
      inputPerMillion: finiteNumber(env.OPENAI_INPUT_COST_PER_MILLION, 0, { name: "OPENAI_INPUT_COST_PER_MILLION" }),
      outputPerMillion: finiteNumber(env.OPENAI_OUTPUT_COST_PER_MILLION, 0, { name: "OPENAI_OUTPUT_COST_PER_MILLION" }),
    }),
  });
}

function requested(configuration, key, maximum) {
  const value = configuration?.[key];
  if (value === undefined || value === null || value === "") return maximum;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`configuration.${key} must be a non-negative number`);
  return Math.min(parsed, maximum);
}

/** A job may lower any server limit, never raise it. */
export function limitsForJob(config, configuration = {}) {
  const maxBudgetUsd = config.limits.maxBudgetUsd > 0
    ? requested(configuration, "max_budget_usd", config.limits.maxBudgetUsd)
    : 0;
  return Object.freeze({
    maxAiCalls: Math.floor(requested(configuration, "max_ai_calls", config.limits.maxAiCalls)),
    maxRevisionCycles: Math.floor(requested(configuration, "max_revision_cycles", config.limits.maxRevisionCycles)),
    maxResearchSources: Math.floor(requested(configuration, "max_research_sources", config.limits.maxResearchSources)),
    maxTotalTokens: Math.floor(requested(configuration, "max_tokens", config.limits.maxTotalTokens)),
    maxBudgetUsd,
  });
}
