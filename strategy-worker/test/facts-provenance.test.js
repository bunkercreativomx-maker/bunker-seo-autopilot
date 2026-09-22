import test from "node:test";
import assert from "node:assert/strict";
import { buildStrategy } from "../src/engine.js";

const base = {
  client: { id: "client1", business_name: "Solar Co", services: "Solar panel installation", products: "", primary_location: "Juarez", service_areas: "Juarez", country: "MX" },
  website: { id: "site1", country: "MX", target_locations: "Juarez" },
  pages: [{ id: "p1", url: "https://solar.test/", path: "/", title: "Solar Co", h1: "Solar panels in Juarez", word_count: 600, indexable: true, status_code: 200 }],
  links: [], issues: [], previous_version: 0,
};

test("only verified business facts are treated as authoritative services", () => {
  const facts = [
    { id: "f1", fact_type: "service", value: "Battery storage", verified: true, verification_state: "verified", provenance: "user_provided" },
    { id: "f2", fact_type: "service", value: "AI-invented service", verified: false, verification_state: "ai_inferred", provenance: "ai_inferred" },
  ];
  const result = buildStrategy({ ...base, facts });
  assert.ok(result.keywords.some((item) => item.normalized_keyword === "battery storage"), "verified fact service is used");
  assert.equal(result.keywords.some((item) => item.normalized_keyword === "ai invented service"), false, "AI-inferred fact must not become a service");
  assert.equal(result.provenance.verified_facts_only, true);
  assert.equal(result.provenance.fact_provenance.verified, 1);
  assert.equal(result.provenance.fact_provenance.ai_inferred, 1);
});

test("unverified facts do not silently become business truth", () => {
  const facts = [
    { id: "f1", fact_type: "service", value: "Unverified service", verified: false, verification_state: "unverified", provenance: "website" },
  ];
  const result = buildStrategy({ ...base, facts });
  assert.equal(result.keywords.some((item) => item.normalized_keyword === "unverified service"), false);
  assert.equal(result.provenance.fact_provenance.unverified, 1);
});

test("an explicit human verified flag still promotes a fact to authoritative", () => {
  const facts = [
    { id: "f1", fact_type: "service", value: "Human confirmed service", verified: true, provenance: "ai_inferred" },
  ];
  const result = buildStrategy({ ...base, facts });
  assert.ok(result.keywords.some((item) => item.normalized_keyword === "human confirmed service"));
});

test("plan action titles use human-readable page labels, not raw enums", () => {
  const result = buildStrategy(base);
  const titles = Object.values(result.plan).flat().map((a) => a.title).join(" ");
  assert.ok(!/service location page/.test(titles), "no awkward 'service location page' label");
  assert.ok(/Service Page/.test(titles) || /Local Service Page/.test(titles), "human-readable page label present");
});
