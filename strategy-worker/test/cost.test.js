import test from "node:test";
import assert from "node:assert/strict";
import { calculateCost } from "../src/cost.js";

test("cost is null (unknown) when no model pricing is configured", () => {
  assert.equal(calculateCost({ inputTokens: 100, outputTokens: 25, pricing: {} }), null);
  assert.equal(calculateCost({ inputTokens: 100, outputTokens: 25, pricing: { inputPerMillion: 0, outputPerMillion: 0 } }), null);
  assert.equal(calculateCost({ inputTokens: 100, outputTokens: 25 }), null);
});

test("cost is computed from configured per-million pricing", () => {
  const cost = calculateCost({ inputTokens: 100, outputTokens: 25, pricing: { inputPerMillion: 2, outputPerMillion: 8 } });
  assert.equal(cost, (100 * 2 + 25 * 8) / 1_000_000);
});

test("cost is config-driven, never hard-coded to a model", () => {
  // Different pricing config yields a different cost for the same tokens.
  const cheap = calculateCost({ inputTokens: 1000, outputTokens: 1000, pricing: { inputPerMillion: 0.5, outputPerMillion: 1.5 } });
  const expensive = calculateCost({ inputTokens: 1000, outputTokens: 1000, pricing: { inputPerMillion: 5, outputPerMillion: 15 } });
  assert.ok(expensive > cheap);
});
