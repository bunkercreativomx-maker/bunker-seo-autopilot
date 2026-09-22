// Configuration-driven AI cost calculator.
//
// Model pricing is NOT hard-coded here. Pricing comes from the worker config
// (env-driven, per-million token rates). When no pricing is configured the
// calculator returns null so callers can persist "no cost known" instead of a
// fabricated 0.00. Phase 4 can supply model pricing purely through config
// without any schema redesign.

export function calculateCost({ inputTokens = 0, outputTokens = 0, pricing = {} } = {}) {
  const inputPerMillion = Number(pricing?.inputPerMillion) || 0;
  const outputPerMillion = Number(pricing?.outputPerMillion) || 0;
  // No pricing configured -> cost is unknown, not zero.
  if (inputPerMillion <= 0 && outputPerMillion <= 0) return null;
  const input = Math.max(0, Number(inputTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);
  return (input * inputPerMillion + output * outputPerMillion) / 1_000_000;
}
