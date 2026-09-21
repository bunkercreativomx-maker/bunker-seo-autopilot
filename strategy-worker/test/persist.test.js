import test from "node:test";
import assert from "node:assert/strict";
import { persistStrategy, recordAIUsage } from "../src/persist.js";
import { DEFAULT_COLLECTIONS } from "../src/pb.js";

function mockPocketBase({ failCollection } = {}) {
  const calls = [];
  let id = 0;
  return {
    calls,
    collection(name) {
      return {
        async create(payload) {
          calls.push({ method: "create", name, payload });
          if (name === failCollection) throw new Error("write failed");
          return { id: `${name}-${++id}`, ...payload };
        },
        async update(recordId, payload) { calls.push({ method: "update", name, recordId, payload }); return { id: recordId, ...payload }; },
        async delete(recordId) { calls.push({ method: "delete", name, recordId }); return true; },
      };
    },
  };
}

const context = { organization: { id: "o" }, client: { id: "c", primary_language: "en" }, website: { id: "w", country: "US" }, job: { id: "j", triggered_by: "u" } };
const keyword = {
  id: "engine-kw", key: "kw-one", keyword: "one", normalized_keyword: "one", source_types: ["client"], sources: [{ value: "one" }],
  intent: "transactional", page_type: "service", cluster: "one", cluster_key: "one", existing_page_id: null, existing_page_url: null,
  competing_page_ids: [], mapping_score: null, priority_score: 70, priority_breakdown: { score: 70 },
};
const strategy = {
  version: 2, engine_version: "test", provenance: { fabricated_metrics: false }, keywords: [keyword],
  clusters: [{ id: "engine-cl", key: "one", name: "one", keyword_ids: ["engine-kw"], pillar_page_id: null, evidence: {} }],
  gaps: [], cannibalization: [], internal_links: [], plan: { 30: [], 60: [], 90: [] },
};

test("persists schema-compatible version, keyword, mapping, cluster, and plan", async () => {
  const pb = mockPocketBase();
  const result = await persistStrategy(pb, strategy, context, DEFAULT_COLLECTIONS, "2026-01-01T00:00:00.000Z");
  assert.equal(result.version.version, 2);
  const savedKeyword = pb.calls.find((call) => call.method === "create" && call.name === "keywords");
  assert.equal(savedKeyword.payload.organization, "o");
  assert.equal(savedKeyword.payload.language, "en");
  assert.equal(savedKeyword.payload.search_volume, null);
  assert.equal(savedKeyword.payload.status, "discovered");
  assert.ok(pb.calls.some((call) => call.method === "create" && call.name === "keyword_page_mappings"));
  assert.ok(pb.calls.some((call) => call.method === "create" && call.name === "content_plans"));
});

test("copies trusted manual values and metadata into the new immutable version", async () => {
  const pb = mockPocketBase();
  const overridden = { ...keyword, intent: "commercial", priority: "critical", status: "approved", manual_override: true, manual_fields: ["intent", "priority", "status"], overridden_by: "u", overridden_at: "2026-01-01T00:00:00Z" };
  await persistStrategy(pb, { ...strategy, keywords: [overridden] }, context);
  const saved = pb.calls.find((call) => call.method === "create" && call.name === "keywords").payload;
  assert.equal(saved.intent, "commercial");
  assert.equal(saved.priority, "critical");
  assert.equal(saved.status, "approved");
  assert.deepEqual(saved.manual_fields, ["intent", "priority", "status"]);
  assert.equal(saved.overridden_by, "u");
});

test("deletes an incomplete version when a generated record write fails", async () => {
  const pb = mockPocketBase({ failCollection: "keywords" });
  await assert.rejects(persistStrategy(pb, strategy, context), /write failed/);
  assert.ok(pb.calls.some((call) => call.method === "delete" && call.name === "strategy_versions"));
});

test("Null-provider usage creates no ai_usage record", async () => {
  const pb = mockPocketBase();
  const result = await recordAIUsage(pb, { provider: "null", calls: 0, inputTokens: 0, outputTokens: 0 }, context);
  assert.equal(result, null);
  assert.equal(pb.calls.length, 0);
});
