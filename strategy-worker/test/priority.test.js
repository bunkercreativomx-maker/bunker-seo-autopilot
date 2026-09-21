import test from "node:test";
import assert from "node:assert/strict";
import { calculatePriority, planHorizon } from "../src/priority.js";

 test("priority score exposes every additive component", () => {
  const result = calculatePriority({ sourceCount: 3, businessRelevant: true, isGap: true, issueSeverity: "high", cannibalization: true, hasPage: true });
  assert.equal(result.score, 100);
  assert.deepEqual(result.components, { evidence: 30, business: 30, gap: 20, technical: 12, cannibalization: 10, mappedPage: 5 });
  assert.match(result.formula, /evidence/);
});

test("30/60/90 assignment uses transparent thresholds", () => {
  assert.equal(planHorizon(70, "content_gap"), 30);
  assert.equal(planHorizon(45, "content_gap"), 60);
  assert.equal(planHorizon(44, "content_gap"), 90);
  assert.equal(planHorizon(1, "cannibalization"), 30);
});
