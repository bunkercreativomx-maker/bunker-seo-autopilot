import test from "node:test";
import assert from "node:assert/strict";
import { scheduleAction, planHorizon } from "../src/priority.js";

test("30/60/90 assignment uses transparent thresholds (backward-compatible wrapper)", () => {
  assert.equal(planHorizon(70, "content_gap"), 30);
  assert.equal(planHorizon(45, "content_gap"), 60);
  assert.equal(planHorizon(44, "content_gap"), 90);
  assert.equal(planHorizon(1, "cannibalization"), 30);
});

test("technical and cannibalization work is always immediate", () => {
  assert.equal(scheduleAction({ type: "cannibalization", priority: 1 }), 30);
  assert.equal(scheduleAction({ type: "technical", priority: 1 }), 30);
});

test("internal linking is scheduled mid-plan, not day one", () => {
  assert.equal(scheduleAction({ type: "internal_link", priority: 90 }), 60);
});

test("high-priority service pages stay in days 1-30", () => {
  assert.equal(scheduleAction({ type: "content_gap", pageType: "service_page", priority: 90 }), 30);
  assert.equal(scheduleAction({ type: "content_gap", pageType: "service_page", priority: 70 }), 30);
});

test("strategic location pages are mid-plan even at high priority (unless critical)", () => {
  assert.equal(scheduleAction({ type: "content_gap", pageType: "location_page", priority: 70 }), 60);
  assert.equal(scheduleAction({ type: "content_gap", pageType: "location_page", priority: 90 }), 30);
});

test("supporting informational content lands in days 61-90, not day one", () => {
  assert.equal(scheduleAction({ type: "content_gap", pageType: "blog_article", intent: "informational", priority: 70 }), 60);
  assert.equal(scheduleAction({ type: "content_gap", pageType: "blog_article", intent: "informational", priority: 40 }), 90);
  assert.equal(scheduleAction({ type: "content_gap", pageType: "blog_article", intent: "informational", priority: 90 }), 30);
});

test("refresh/optimization of existing pages is scheduled late", () => {
  assert.equal(scheduleAction({ type: "refresh", priority: 50 }), 90);
  assert.equal(scheduleAction({ type: "optimize", pageType: "existing_page", priority: 50 }), 90);
});

test("a realistic mix fills all three buckets without mechanically equal counts", () => {
  const actions = [
    { type: "cannibalization", priority: 60 },
    { type: "content_gap", pageType: "service_page", priority: 90 },
    { type: "content_gap", pageType: "service_page", priority: 80 },
    { type: "content_gap", pageType: "location_page", priority: 70 },
    { type: "content_gap", pageType: "location_page", priority: 60 },
    { type: "internal_link", priority: 55 },
    { type: "content_gap", pageType: "blog_article", intent: "informational", priority: 50 },
    { type: "content_gap", pageType: "blog_article", intent: "informational", priority: 40 },
    { type: "refresh", priority: 45 },
  ];
  const buckets = { 30: [], 60: [], 90: [] };
  for (const a of actions) buckets[scheduleAction(a)].push(a);
  assert.ok(buckets[30].length > 0, "days 1-30 must not be empty");
  assert.ok(buckets[60].length > 0, "days 31-60 must not be empty");
  assert.ok(buckets[90].length > 0, "days 61-90 must not be empty");
  // Critical work is never pushed late just to fill a bucket.
  assert.ok(buckets[30].some((a) => a.priority >= 80), "critical work stays in days 1-30");
});
