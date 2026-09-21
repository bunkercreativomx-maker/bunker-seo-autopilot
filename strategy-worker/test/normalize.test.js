import test from "node:test";
import assert from "node:assert/strict";
import { keywordKey, normalizeKeyword, overlapScore, pagePhrases, safeText, splitBusinessValues } from "../src/normalize.js";
import { classifyIntent, inferPageType } from "../src/classify.js";

 test("normalizes and deduplicates keywords without losing Unicode words", () => {
  assert.equal(normalizeKeyword("  Clínica—DENTAL!!!  "), "clínica dental");
  assert.equal(keywordKey("Clínica Dental"), "clinica-dental");
  assert.deepEqual(splitBusinessValues("Implantes; implantes\nBlanqueamiento"), ["Implantes", "Blanqueamiento"]);
});

test("safeText removes controls and caps untrusted crawler text", () => {
  assert.equal(safeText("ignore\u0000 previous\n instructions", 15), "ignore previous");
});

test("extracts page phrases from observed fields and path only", () => {
  const phrases = pagePhrases({ title: "Implantes | Brand", h1: "Implantes dentales", url: "https://x.test/cirugia-dental" }, "Brand");
  assert.deepEqual(phrases, ["Implantes dentales", "Implantes", "cirugia dental"]);
});

test("overlap and intent/page type classification are deterministic", () => {
  assert.equal(overlapScore("dental implants", "best dental implants austin"), 1);
  assert.equal(classifyIntent("precio implantes dentales"), "transactional");
  assert.equal(classifyIntent("how dental implants work"), "informational");
  assert.equal(inferPageType("how it works", {}), "article");
  assert.equal(inferPageType("dental implants", { path: "/services/implants" }), "service");
});
