import test from "node:test";
import assert from "node:assert/strict";
import { buildStrategy } from "../src/engine.js";

const base = {
  client: { id: "client1", business_name: "Tlaloc", services: "Residential solar energy systems, Solar panel installation", products: "", primary_location: "Ciudad Juarez", service_areas: "Ciudad Juarez", country: "MX" },
  website: { id: "site1", country: "MX", target_locations: "Ciudad Juarez" },
  pages: [
    { id: "p1", url: "https://solar.test/", path: "/", title: "Tlaloc Sol Futuro", h1: "Energia solar en Ciudad Juarez", word_count: 600, indexable: true, status_code: 200 },
  ],
  links: [],
  issues: [],
  previous_version: 0,
};

test("country is never treated as a service area keyword", () => {
  const result = buildStrategy(base);
  const junk = result.keywords.filter((item) => /^[a-z]{2}$/.test(item.normalized_keyword.split(" ").at(-1)));
  assert.deepEqual(junk, [], "no keyword should end with a bare country code");
  assert.equal(result.keywords.some((item) => item.normalized_keyword.endsWith(" mx")), false);
  // The declared location still generates local combinations.
  assert.ok(result.keywords.some((item) => item.normalized_keyword.includes("ciudad juarez")));
});

test("a location equal to the country value is dropped", () => {
  const result = buildStrategy({ ...base, website: { id: "site1", country: "Mexico", target_locations: "Mexico" }, client: { ...base.client, country: "Mexico", service_areas: "Mexico" } });
  assert.equal(result.keywords.some((item) => item.normalized_keyword.endsWith(" mexico")), false);
});

test("approved manual keyword survives regeneration with AI discovery disabled", () => {
  const prior = {
    id: "kw1", key: "financiamiento-solar-ciudad-juarez",
    keyword: "Financiamiento solar Ciudad Juarez", normalized_keyword: "financiamiento solar ciudad juarez",
    intent: "commercial", priority: "critical", status: "approved", topic: "Financiamiento solar",
    manual_override: true, manual_fields: ["intent", "priority", "status"],
    overridden_by: "user1", overridden_at: "2026-01-01T00:00:00.000Z",
  };
  const result = buildStrategy({ ...base, existing: { keywords: [prior] }, ai_candidates: [] });
  const carried = result.keywords.find((item) => item.normalized_keyword === "financiamiento solar ciudad juarez");
  assert.ok(carried, "approved keyword must be carried forward");
  assert.equal(carried.manual_override, true);
  assert.equal(carried.source_types.includes("manual"), true);
  assert.equal(carried.priority, "critical");
  assert.equal(carried.status, "approved");
  assert.equal(carried.search_volume, null);
  assert.equal(carried.cpc, null);
  assert.equal(carried.keyword_difficulty, null);
});

test("non-manual keywords are never carried forward when the generator drops them", () => {
  const prior = { id: "kw2", key: "old-phrase", keyword: "old phrase", normalized_keyword: "old phrase", manual_override: false, manual_fields: [] };
  const result = buildStrategy({ ...base, existing: { keywords: [prior] } });
  assert.equal(result.keywords.some((item) => item.normalized_keyword === "old phrase"), false);
});

test("carried keywords do not duplicate a regenerated equivalent", () => {
  const prior = {
    id: "kw3", key: "solar-panel-installation", keyword: "Solar panel installation", normalized_keyword: "solar panel installation",
    intent: "commercial", priority: "high", status: "approved", topic: "Solar panel installation",
    manual_override: true, manual_fields: ["status"],
  };
  const result = buildStrategy({ ...base, existing: { keywords: [prior] } });
  const matches = result.keywords.filter((item) => item.normalized_keyword === "solar panel installation");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].status, "approved");
});