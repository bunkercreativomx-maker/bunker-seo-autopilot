import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultVerificationState,
  isVerified,
  normalizeProvenance,
  pageTypeLabel,
  opportunityLabel,
  intentLabel,
} from "../src/provenance.js";

test("AI-inferred values are never verified by default", () => {
  assert.equal(defaultVerificationState("ai_inferred"), "ai_inferred");
  assert.equal(isVerified({ provenance: "ai_inferred", verification_state: "ai_inferred" }), false);
  assert.equal(isVerified({ provenance: "ai_inferred", verified: true }), true, "an explicit human verified flag still wins");
});

test("user-provided and manual values are user-confirmed, not auto-verified", () => {
  assert.equal(defaultVerificationState("user_provided"), "user_confirmed");
  assert.equal(defaultVerificationState("manual"), "user_confirmed");
  assert.equal(isVerified({ provenance: "user_provided" }), false, "user-provided alone is not 'verified'");
});

test("website, crawler and external sources start unverified", () => {
  assert.equal(defaultVerificationState("website"), "unverified");
  assert.equal(defaultVerificationState("crawler"), "unverified");
  assert.equal(defaultVerificationState("external_source"), "unverified");
});

test("provenance strings normalize to the supported enum", () => {
  assert.equal(normalizeProvenance("ai"), "ai_inferred");
  assert.equal(normalizeProvenance("AI-generated"), "ai_inferred");
  assert.equal(normalizeProvenance("user"), "user_provided");
  assert.equal(normalizeProvenance("crawl"), "crawler");
  assert.equal(normalizeProvenance("third_party"), "external_source");
  assert.equal(normalizeProvenance("made-up-thing"), "unknown");
});

test("human-readable page type labels map from stable internal enums", () => {
  assert.equal(pageTypeLabel("service_page"), "Service Page");
  assert.equal(pageTypeLabel("location_page"), "Location Page");
  assert.equal(pageTypeLabel("blog_article"), "Blog Article");
  assert.equal(pageTypeLabel("guide"), "Guide");
  assert.equal(pageTypeLabel("comparison"), "Comparison Page");
  assert.equal(pageTypeLabel("existing_page"), "Existing Page Optimization");
  assert.equal(pageTypeLabel("service"), "Service Page");
  assert.equal(pageTypeLabel("location"), "Location Page");
  assert.equal(pageTypeLabel("article"), "Blog Article");
  assert.equal(pageTypeLabel("unknown_enum"), "unknown_enum");
});

test("opportunity and intent labels are human-readable", () => {
  assert.equal(opportunityLabel("create"), "Create New Page");
  assert.equal(opportunityLabel("internal_link"), "Add Internal Link");
  assert.equal(intentLabel("navigational"), "Navigational");
  assert.equal(intentLabel("mixed"), "Mixed");
});
