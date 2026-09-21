export class AIProviderError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "AIProviderError";
    this.retryable = options.retryable ?? true;
    this.status = options.status;
  }
}

export class NullAIProvider {
  constructor() {
    this.name = "null";
    this.calls = 0;
  }

  async generateStructured() {
    return { used: false, value: null, usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 } };
  }
}

function responseText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  for (const output of response?.output || []) {
    for (const content of output?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return null;
}

export class OpenAIProvider {
  constructor({ apiKey, baseUrl = "https://api.openai.com/v1", pricing = {}, fetchImpl = globalThis.fetch } = {}) {
    if (!apiKey) throw new Error("OpenAIProvider requires apiKey");
    if (typeof fetchImpl !== "function") throw new Error("OpenAIProvider requires fetch");
    this.name = "openai";
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetch = fetchImpl;
    this.calls = 0;
    this.pricing = {
      inputPerMillion: Number(pricing.inputPerMillion) || 0,
      outputPerMillion: Number(pricing.outputPerMillion) || 0,
    };
  }

  async generateStructured({ model, instructions, input, schema, schemaName = "structured_response", signal }) {
    if (!model || !schema || !instructions) throw new TypeError("model, instructions, and schema are required");
    this.calls++;
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
      if (error?.name === "AbortError") throw new AIProviderError("OpenAI request aborted", { cause: error });
      throw new AIProviderError(`OpenAI request failed: ${error?.message || error}`, { cause: error });
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
      throw new AIProviderError(`OpenAI Responses API returned ${response.status}: ${detail}`, { status: response.status, retryable });
    }
    const json = await response.json();
    const text = responseText(json);
    if (!text) throw new AIProviderError("OpenAI response did not contain output_text");
    let value;
    try { value = JSON.parse(text); }
    catch (error) { throw new AIProviderError("OpenAI output was not valid JSON", { cause: error }); }
    const inputTokens = Number(json.usage?.input_tokens) || 0;
    const outputTokens = Number(json.usage?.output_tokens) || 0;
    return {
      value,
      usage: {
        inputTokens,
        outputTokens,
        estimatedCost: (inputTokens * this.pricing.inputPerMillion + outputTokens * this.pricing.outputPerMillion) / 1_000_000,
      },
    };
  }
}

export function createAIProvider(config, options = {}) {
  if (config.provider === "null") return new NullAIProvider();
  if (config.provider === "openai") return new OpenAIProvider({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    pricing: config.pricing,
    fetchImpl: options.fetchImpl,
  });
  throw new Error(`Unsupported AI provider: ${config.provider}`);
}

export async function requestStructured(provider, request, { validate, retries = 2, timeoutMs = 10_000, onUsage = () => {} } = {}) {
  if (!provider || typeof provider.generateStructured !== "function") throw new TypeError("provider.generateStructured is required");
  if (typeof validate !== "function") throw new TypeError("validate is required");
  if (provider instanceof NullAIProvider || provider.name === "null") {
    return { value: null, usage: { provider: "null", model: request.model || "none", calls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 } };
  }

  const aggregate = { provider: provider.name || "custom", model: request.model || "unknown", calls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    let rejectTimeout;
    const timedOut = new Promise((_, reject) => { rejectTimeout = reject; });
    const timer = setTimeout(() => {
      controller.abort();
      rejectTimeout(new AIProviderError(`AI provider timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    try {
      const response = await Promise.race([
        provider.generateStructured({ ...request, signal: controller.signal }),
        timedOut,
      ]);
      const attemptUsage = {
        provider: aggregate.provider,
        model: aggregate.model,
        calls: 1,
        inputTokens: Number(response?.usage?.inputTokens) || 0,
        outputTokens: Number(response?.usage?.outputTokens) || 0,
        estimatedCost: Number(response?.usage?.estimatedCost) || 0,
      };
      aggregate.calls += 1;
      aggregate.inputTokens += attemptUsage.inputTokens;
      aggregate.outputTokens += attemptUsage.outputTokens;
      aggregate.estimatedCost += attemptUsage.estimatedCost;
      await onUsage(attemptUsage);
      const validation = validate(response?.value);
      if (validation !== true) throw new AIProviderError(typeof validation === "string" ? validation : "AI response failed schema validation");
      return { value: response.value, usage: aggregate };
    } catch (error) {
      lastError = error?.name === "AbortError" ? new AIProviderError(`AI provider timed out after ${timeoutMs}ms`, { cause: error }) : error;
      if (controller.signal.aborted && !/timed out/.test(lastError?.message || "")) {
        lastError = new AIProviderError(`AI provider timed out after ${timeoutMs}ms`, { cause: error });
      }
      if (attempt === retries || lastError?.retryable === false) break;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  throw new AIProviderError(`AI provider failed after at most ${retries + 1} attempt(s): ${lastError?.message || lastError}`, { cause: lastError, retryable: false });
}
