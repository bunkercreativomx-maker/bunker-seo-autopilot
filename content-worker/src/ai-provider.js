// AI provider abstraction (same architecture as the Phase 3 strategy worker),
// extended for task-based routing, per-call budget enforcement and usage
// accounting. Providers only ever return structured JSON validated by the caller.
import { calculateCost } from "./cost.js";

export class AIProviderError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "AIProviderError";
    this.retryable = options.retryable ?? true;
    this.status = options.status;
    this.code = options.code || "AI_ERROR";
  }
}

export class NullAIProvider {
  constructor() {
    this.name = "null";
  }

  async generateStructured() {
    throw new AIProviderError("AI provider is disabled (AI_PROVIDER=null); content generation requires a configured provider", { retryable: false, code: "AI_DISABLED" });
  }
}

function responseText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  for (const output of response?.output || []) {
    for (const content of output?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") return content.text;
      if (content?.type === "refusal") throw new AIProviderError(`Model refused: ${String(content.refusal || "").slice(0, 200)}`, { retryable: false, code: "AI_REFUSAL" });
    }
  }
  return null;
}

export class OpenAIProvider {
  constructor({ apiKey, baseUrl = "https://api.openai.com/v1", pricing = {}, fetchImpl = globalThis.fetch } = {}) {
    if (!apiKey) throw new Error("OpenAIProvider requires apiKey");
    this.name = "openai";
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetch = fetchImpl;
    this.pricing = pricing;
  }

  async generateStructured({ model, instructions, input, schema, schemaName = "structured_response", signal }) {
    if (!model || !schema || !instructions) throw new TypeError("model, instructions, and schema are required");
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/responses`, {
        method: "POST",
        signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          instructions,
          input: typeof input === "string" ? input : JSON.stringify(input),
          text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
        }),
      });
    } catch (error) {
      if (error?.name === "AbortError") throw new AIProviderError("OpenAI request aborted", { cause: error, code: "AI_TIMEOUT" });
      throw new AIProviderError(`OpenAI request failed: ${error?.message || error}`, { cause: error });
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
      throw new AIProviderError(`OpenAI Responses API returned ${response.status}: ${detail}`, { status: response.status, retryable });
    }
    const json = await response.json();
    const inputTokens = Number(json.usage?.input_tokens) || 0;
    const outputTokens = Number(json.usage?.output_tokens) || 0;
    const usage = { inputTokens, outputTokens, estimatedCost: calculateCost({ inputTokens, outputTokens, pricing: this.pricing }) };
    if (json.status === "incomplete") {
      const error = new AIProviderError(`OpenAI response incomplete: ${json.incomplete_details?.reason || "unknown"}`, { code: "AI_INCOMPLETE" });
      error.usage = usage;
      throw error;
    }
    const text = responseText(json);
    if (!text) {
      const error = new AIProviderError("OpenAI response did not contain output_text", { code: "AI_MALFORMED" });
      error.usage = usage;
      throw error;
    }
    let value;
    try { value = JSON.parse(text); }
    catch (cause) {
      const error = new AIProviderError("OpenAI output was not valid JSON", { cause, code: "AI_MALFORMED" });
      error.usage = usage;
      throw error;
    }
    return { value, usage };
  }
}

export function createAIProvider(config, options = {}) {
  if (config.provider === "null") return new NullAIProvider();
  if (config.provider === "openai") {
    return new OpenAIProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl, pricing: config.pricing, fetchImpl: options.fetchImpl });
  }
  throw new Error(`Unsupported AI provider: ${config.provider}`);
}

/**
 * Task-routed structured call with timeout, bounded retries, validation,
 * budget enforcement before EVERY attempt, and per-attempt usage accounting
 * (a malformed or rejected attempt still costs tokens and is recorded).
 */
export async function callTask(ctx, task, { instructions, input, schema, validate, timeoutMs }) {
  const { provider, config, budget, onUsage = async () => {} } = ctx;
  if (typeof validate !== "function") throw new TypeError("validate is required");
  const model = config.models[task];
  if (!model) throw new Error(`No model configured for task ${task}`);
  const retries = config.retries;
  const limit = timeoutMs || config.timeoutMs;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    budget.assertCanCall(task);
    const controller = new AbortController();
    let rejectTimeout;
    const timedOut = new Promise((_, reject) => { rejectTimeout = reject; });
    const timer = setTimeout(() => {
      // Settle the timeout first so the race reports AI_TIMEOUT, then abort the request.
      rejectTimeout(new AIProviderError(`AI provider timed out after ${limit}ms (${task})`, { code: "AI_TIMEOUT" }));
      controller.abort();
    }, limit);
    timer.unref?.();
    let usage = null;
    try {
      const response = await Promise.race([
        provider.generateStructured({ model, instructions, input, schema, schemaName: task, signal: controller.signal }),
        timedOut,
      ]);
      usage = response?.usage || { inputTokens: 0, outputTokens: 0, estimatedCost: null };
      const validation = validate(response?.value);
      if (validation !== true) {
        throw new AIProviderError(`AI output failed validation for ${task}: ${typeof validation === "string" ? validation : "invalid"}`, { code: "AI_MALFORMED" });
      }
      return response.value;
    } catch (error) {
      usage = usage || error?.usage || null;
      lastError = error;
      if (error?.code === "BUDGET_EXCEEDED" || error?.retryable === false) break;
    } finally {
      clearTimeout(timer);
      controller.abort();
      // Every attempt that reached the provider counts against the budget,
      // including timeouts (tokens unknown => 0, but the call is counted).
      const accounted = usage || { inputTokens: 0, outputTokens: 0, estimatedCost: null };
      budget.record({ calls: 1, ...accounted });
      await onUsage({ task, provider: provider.name, model, calls: 1, ...accounted });
    }
  }
  const error = new AIProviderError(`AI task ${task} failed: ${lastError?.message || lastError}`, {
    cause: lastError, retryable: false, code: lastError?.code || "AI_ERROR",
  });
  throw error;
}
