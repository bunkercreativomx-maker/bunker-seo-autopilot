#!/usr/bin/env node
/**
 * Phase 3 integration tests — schema, tenant isolation, worker-only writes,
 * strategy lifecycle, nullable metrics, human overrides, and versioning.
 *
 * Prereq: PB_URL=http://127.0.0.1:8097 node scripts/setup-pocketbase.mjs
 * Usage:  PB_URL=http://127.0.0.1:8097 node --test scripts/test-phase3.mjs
 *
 * The suite creates uniquely tagged fixtures and deletes only those fixtures.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import PocketBase from "pocketbase";
import { randomUUID } from "node:crypto";

const PB_URL = process.env.PB_URL || "http://127.0.0.1:8095";
const ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL || "admin@seo.autopilot";
const ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD || "SeoAutopilot!2026x";
const PASS = "Phase3Test!2026";
const TAG = `p3-${randomUUID().slice(0, 8)}`;
const NOW = () => new Date().toISOString();

const COLLECTIONS = [
  "business_facts",
  "keywords",
  "topic_clusters",
  "keyword_page_mappings",
  "content_opportunities",
  "cannibalization_issues",
  "content_plans",
  "content_plan_items",
  "strategy_jobs",
  "strategy_versions",
  "ai_usage",
];

const REQUIRED_FIELDS = {
  business_facts: ["organization", "client", "website", "fact_type", "label", "value", "source", "source_url", "verified", "verified_by", "verified_at", "created_at", "updated_at"],
  keywords: ["organization", "client", "website", "strategy_version", "keyword", "normalized_keyword", "language", "country", "target_location", "intent", "funnel_stage", "topic", "source", "source_query", "existing_target_page", "recommended_target_page", "cluster", "opportunity_type", "priority", "status", "search_volume", "cpc", "keyword_difficulty", "metrics_source", "metrics_updated_at", "created_at", "updated_at"],
  topic_clusters: ["organization", "client", "website", "strategy_version", "name", "description", "primary_topic", "pillar_keyword", "pillar_page", "status", "created_at", "updated_at"],
  keyword_page_mappings: ["organization", "client", "website", "strategy_version", "keyword", "current_page", "recommended_page", "mapping_type", "confidence", "reason", "status", "created_at", "updated_at"],
  content_opportunities: ["organization", "client", "website", "strategy_version", "keyword", "cluster", "opportunity_type", "recommended_page_type", "existing_page", "recommended_url", "title_suggestion", "reason", "priority", "status", "evidence", "created_at", "updated_at"],
  cannibalization_issues: ["organization", "client", "website", "strategy_version", "keyword_group", "pages", "reason", "severity", "recommended_action", "status", "created_at", "updated_at"],
  content_plans: ["organization", "client", "website", "strategy_version", "name", "period", "start_date", "end_date", "status", "created_at", "updated_at"],
  content_plan_items: ["organization", "client", "website", "strategy_version", "plan", "opportunity", "keyword", "cluster", "action", "page_type", "existing_page", "proposed_url", "proposed_title", "priority", "scheduled_period", "status", "reason", "created_at", "updated_at"],
  strategy_jobs: ["organization", "client", "website", "status", "step", "progress", "started_at", "completed_at", "error", "triggered_by", "created_at", "updated_at"],
  strategy_versions: ["organization", "client", "website", "strategy_job", "version", "summary", "generated_at", "generated_by", "configuration", "created_at", "updated_at"],
  ai_usage: ["organization", "client", "website", "job", "strategy_version", "task", "provider", "model", "input_tokens", "output_tokens", "estimated_cost", "timestamp", "created_at", "updated_at"],
};

const OVERRIDE_COLLECTIONS = [
  "business_facts", "keywords", "topic_clusters", "keyword_page_mappings",
  "content_opportunities", "cannibalization_issues", "content_plans", "content_plan_items",
];

let admin;
let userA;
let userB;
const ids = {};
const created = new Map(COLLECTIONS.map((name) => [name, []]));
const remember = (collection, record) => {
  created.get(collection)?.push(record.id);
  return record;
};

async function createCoreFixtures() {
  const orgA = await admin.collection("organizations").create({ name: `${TAG} Org A`, slug: `${TAG}-org-a`, status: "active", created_at: NOW() });
  const orgB = await admin.collection("organizations").create({ name: `${TAG} Org B`, slug: `${TAG}-org-b`, status: "active", created_at: NOW() });
  ids.orgA = orgA.id;
  ids.orgB = orgB.id;

  const clientA = await admin.collection("clients").create({ organization: orgA.id, business_name: `${TAG} Client A`, slug: `${TAG}-client-a`, primary_language: "en", services: "HVAC repair", primary_location: "El Paso", status: "active", created_at: NOW() });
  const clientB = await admin.collection("clients").create({ organization: orgB.id, business_name: `${TAG} Client B`, slug: `${TAG}-client-b`, primary_language: "en", status: "active", created_at: NOW() });
  ids.clientA = clientA.id;
  ids.clientB = clientB.id;

  const websiteA = await admin.collection("websites").create({ organization: orgA.id, client: clientA.id, name: `${TAG} Website A`, domain: `${TAG}-a.example.test`, platform: "custom", status: "active", created_at: NOW() });
  const websiteB = await admin.collection("websites").create({ organization: orgB.id, client: clientB.id, name: `${TAG} Website B`, domain: `${TAG}-b.example.test`, platform: "custom", status: "active", created_at: NOW() });
  ids.websiteA = websiteA.id;
  ids.websiteB = websiteB.id;

  const userRecordA = await admin.collection("users").create({ email: `${TAG}-a@test.local`, password: PASS, passwordConfirm: PASS, name: `${TAG} User A`, organization: orgA.id, role: "admin", status: "active", emailVisibility: false });
  const userRecordB = await admin.collection("users").create({ email: `${TAG}-b@test.local`, password: PASS, passwordConfirm: PASS, name: `${TAG} User B`, organization: orgB.id, role: "admin", status: "active", emailVisibility: false });
  ids.userA = userRecordA.id;
  ids.userB = userRecordB.id;

  userA = new PocketBase(PB_URL);
  userB = new PocketBase(PB_URL);
  await userA.collection("users").authWithPassword(`${TAG}-a@test.local`, PASS);
  await userB.collection("users").authWithPassword(`${TAG}-b@test.local`, PASS);

  const pageA = await admin.collection("website_pages").create({ organization: orgA.id, client: clientA.id, website: websiteA.id, url: `https://${TAG}-a.example.test/services/hvac`, normalized_url: `https://${TAG}-a.example.test/services/hvac`, title: "HVAC Repair", h1: "HVAC Repair", created_at: NOW() });
  const pageA2 = await admin.collection("website_pages").create({ organization: orgA.id, client: clientA.id, website: websiteA.id, url: `https://${TAG}-a.example.test/hvac-repair`, normalized_url: `https://${TAG}-a.example.test/hvac-repair`, title: "HVAC Repair El Paso", h1: "HVAC Repair El Paso", created_at: NOW() });
  ids.pageA = pageA.id;
  ids.pageA2 = pageA2.id;
}

before(async () => {
  admin = new PocketBase(PB_URL);
  await admin.collection("_superusers").authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);
  await createCoreFixtures();
});

test("P3 SCHEMA: all collections, fields, tenant rules, dates, and safe indexes exist", async () => {
  for (const name of COLLECTIONS) {
    const schema = await admin.collections.getOne(name);
    const names = new Set(schema.fields.map((field) => field.name));
    for (const field of REQUIRED_FIELDS[name]) assert.ok(names.has(field), `${name}.${field} missing`);
    assert.equal(schema.listRule, "organization.id = @request.auth.organization.id", `${name} listRule`);
    assert.equal(schema.viewRule, "organization.id = @request.auth.organization.id", `${name} viewRule`);
    for (const index of schema.indexes || []) assert.equal(index.includes("`"), false, `${name} index contains backticks`);
  }
});

test("P3 SCHEMA: generated collections are worker-only and expose manual override metadata", async () => {
  for (const name of COLLECTIONS.filter((name) => name !== "strategy_jobs")) {
    const schema = await admin.collections.getOne(name);
    assert.equal(schema.createRule, null, `${name} createRule must be admin-only`);
    assert.equal(schema.updateRule, null, `${name} updateRule must be admin-only`);
    assert.equal(schema.deleteRule, null, `${name} deleteRule must be admin-only`);
  }
  for (const name of OVERRIDE_COLLECTIONS) {
    const schema = await admin.collections.getOne(name);
    const names = new Set(schema.fields.map((field) => field.name));
    for (const field of ["manual_override", "manual_fields", "overridden_by", "overridden_at"]) {
      assert.ok(names.has(field), `${name}.${field} missing`);
    }
  }
});

test("P3 JOB: user can create only a queued job pinned to their org/client/website", async () => {
  const job = remember("strategy_jobs", await userA.collection("strategy_jobs").create({
    organization: ids.orgA,
    client: ids.clientA,
    website: ids.websiteA,
    status: "queued",
    step: "queued",
    progress: 0,
    triggered_by: ids.userA,
    configuration: { max_keywords_per_strategy: 100, max_ai_calls_per_strategy: 20, max_clusters: 20, max_opportunities: 50 },
    created_at: NOW(),
    updated_at: NOW(),
  }));
  ids.jobA = job.id;
  assert.equal(job.status, "queued");

  await assert.rejects(
    () => userA.collection("strategy_jobs").create({ organization: ids.orgA, client: ids.clientB, website: ids.websiteB, status: "queued", progress: 0, triggered_by: ids.userA, created_at: NOW() }),
    (error) => error.status === 400 || error.status === 403,
  );
  await assert.rejects(
    () => userA.collection("strategy_jobs").create({ organization: ids.orgA, client: ids.clientA, website: ids.websiteA, status: "running", progress: 1, triggered_by: ids.userA, created_at: NOW() }),
    (error) => error.status === 400 || error.status === 403,
  );
});

test("P3 JOB: only worker/admin can advance lifecycle", async () => {
  await assert.rejects(
    () => userA.collection("strategy_jobs").update(ids.jobA, { status: "running", progress: 10 }),
    (error) => error.status === 403 || error.status === 404,
  );
  const running = await admin.collection("strategy_jobs").update(ids.jobA, { status: "running", step: "discovering_keywords", progress: 40, started_at: NOW(), updated_at: NOW() });
  assert.equal(running.status, "running");
  const completed = await admin.collection("strategy_jobs").update(ids.jobA, { status: "completed", step: "completed", progress: 100, completed_at: NOW(), updated_at: NOW() });
  assert.equal(completed.status, "completed");
  assert.equal(completed.progress, 100);
});

test("P3 VERSIONING: immutable versions relate jobs and every strategy artifact", async () => {
  const base = { organization: ids.orgA, client: ids.clientA, website: ids.websiteA };
  const version1 = remember("strategy_versions", await admin.collection("strategy_versions").create({ ...base, strategy_job: ids.jobA, version: 1, summary: "Initial strategy", generated_at: NOW(), generated_by: ids.userA, configuration: { language: "en" }, created_at: NOW(), updated_at: NOW() }));
  const version2 = remember("strategy_versions", await admin.collection("strategy_versions").create({ ...base, strategy_job: ids.jobA, version: 2, summary: "Regenerated strategy", generated_at: NOW(), generated_by: ids.userA, configuration: { language: "en" }, created_at: NOW(), updated_at: NOW() }));
  ids.version1 = version1.id;
  ids.version2 = version2.id;
  assert.notEqual(version1.id, version2.id);
  assert.equal(version1.strategy_job, ids.jobA);
  assert.equal(version2.version, 2);

  const keyword = remember("keywords", await admin.collection("keywords").create({
    ...base, strategy_version: version1.id, keyword: "HVAC repair El Paso", normalized_keyword: "hvac repair el paso", language: "en", country: "US", target_location: "El Paso", intent: "local", intent_confidence: 0.93, funnel_stage: "conversion", topic: "HVAC repair", source: "services", source_query: "HVAC repair", opportunity_type: "optimize", recommended_page_type: "existing_page", priority: "high", status: "discovered", search_volume: null, cpc: null, keyword_difficulty: null, confidence: 0.9, evidence: [{ type: "client_service", value: "HVAC repair" }], created_at: NOW(), updated_at: NOW(),
  }));
  ids.keyword = keyword.id;

  const cluster = remember("topic_clusters", await admin.collection("topic_clusters").create({ ...base, strategy_version: version1.id, name: "HVAC Repair", primary_topic: "HVAC repair", pillar_keyword: keyword.id, pillar_page: ids.pageA, status: "draft", confidence: 0.88, evidence: [{ type: "crawler_page", id: ids.pageA }], created_at: NOW(), updated_at: NOW() }));
  ids.cluster = cluster.id;
  await admin.collection("keywords").update(keyword.id, { cluster: cluster.id, updated_at: NOW() });

  const mapping = remember("keyword_page_mappings", await admin.collection("keyword_page_mappings").create({ ...base, strategy_version: version1.id, keyword: keyword.id, current_page: ids.pageA, recommended_page: `/services/hvac`, mapping_type: "recommended_existing", confidence: 0.92, reason: "An existing service page matches the commercial-local intent.", evidence: [{ type: "crawler_page", id: ids.pageA }], status: "proposed", created_at: NOW(), updated_at: NOW() }));
  const opportunity = remember("content_opportunities", await admin.collection("content_opportunities").create({ ...base, strategy_version: version1.id, keyword: keyword.id, cluster: cluster.id, opportunity_type: "optimize", recommended_page_type: "existing_page", existing_page: ids.pageA, recommended_url: "/services/hvac", title_suggestion: "HVAC Repair in El Paso", reason: "The existing service page matches intent but needs local relevance.", priority: "high", status: "proposed", evidence: [{ type: "crawler_page", id: ids.pageA }], confidence: 0.9, created_at: NOW(), updated_at: NOW() }));
  const issue = remember("cannibalization_issues", await admin.collection("cannibalization_issues").create({ ...base, strategy_version: version1.id, keyword_group: "hvac repair el paso", pages: [ids.pageA, ids.pageA2], reason: "Two indexable service URLs substantially overlap in topic and intent.", severity: "medium", recommended_action: "Choose one canonical service page and consolidate unique value.", status: "open", confidence: 0.82, evidence: [{ type: "title_overlap", pages: [ids.pageA, ids.pageA2] }], created_at: NOW(), updated_at: NOW() }));
  const plan = remember("content_plans", await admin.collection("content_plans").create({ ...base, strategy_version: version1.id, name: "90-day SEO roadmap", period: "30_60_90", status: "draft", created_at: NOW(), updated_at: NOW() }));
  const item = remember("content_plan_items", await admin.collection("content_plan_items").create({ ...base, strategy_version: version1.id, plan: plan.id, opportunity: opportunity.id, keyword: keyword.id, cluster: cluster.id, action: "optimize_existing_page", page_type: "existing_page", existing_page: ids.pageA, proposed_url: "/services/hvac", proposed_title: "HVAC Repair in El Paso", priority: "high", scheduled_period: "days_1_30", status: "planned", reason: "Strengthen the primary commercial service page first.", evidence: [{ type: "content_opportunity", id: opportunity.id }], created_at: NOW(), updated_at: NOW() }));
  const usage = remember("ai_usage", await admin.collection("ai_usage").create({ ...base, job: ids.jobA, strategy_version: version1.id, task: "intent_classification", provider: "test-provider", model: "test-model", input_tokens: 20, output_tokens: 10, estimated_cost: 0, timestamp: NOW(), created_at: NOW(), updated_at: NOW() }));

  for (const record of [keyword, cluster, mapping, opportunity, issue, plan, item, usage]) {
    assert.equal(record.strategy_version, version1.id, `${record.collectionName} version relation`);
  }
});

test("P3 METRICS: unavailable keyword metrics remain null, never numeric zero", async () => {
  const keyword = await admin.collection("keywords").getOne(ids.keyword);
  assert.equal(keyword.search_volume, null);
  assert.equal(keyword.cpc, null);
  assert.equal(keyword.keyword_difficulty, null);
  assert.equal(keyword.metrics_source, "");
});

test("P3 OVERRIDES: trusted override persists and direct user writes stay blocked", async () => {
  const updated = await admin.collection("keywords").update(ids.keyword, {
    intent: "commercial",
    priority: "critical",
    status: "approved",
    manual_override: true,
    manual_fields: ["intent", "priority", "status"],
    overridden_by: ids.userA,
    overridden_at: NOW(),
    updated_at: NOW(),
  });
  assert.equal(updated.manual_override, true);
  assert.deepEqual(updated.manual_fields, ["intent", "priority", "status"]);
  assert.equal(updated.overridden_by, ids.userA);
  await assert.rejects(
    () => userA.collection("keywords").update(ids.keyword, { priority: "low" }),
    (error) => error.status === 403 || error.status === 404,
  );
  const persisted = await admin.collection("keywords").getOne(ids.keyword);
  assert.equal(persisted.priority, "critical");
});

test("P3 TENANT: users see only their tenant and cannot read another tenant's strategy", async () => {
  const factB = remember("business_facts", await admin.collection("business_facts").create({ organization: ids.orgB, client: ids.clientB, website: ids.websiteB, fact_type: "service", label: "Service", value: "Roofing", source: "manual", verified: false, created_at: NOW(), updated_at: NOW() }));
  const ownKeywords = await userA.collection("keywords").getFullList({ filter: `id = "${ids.keyword}"` });
  assert.equal(ownKeywords.length, 1);
  await assert.rejects(
    () => userA.collection("business_facts").getOne(factB.id),
    (error) => error.status === 403 || error.status === 404,
  );
  const userBKeywords = await userB.collection("keywords").getFullList({ filter: `id = "${ids.keyword}"` });
  assert.equal(userBKeywords.length, 0);
});

test("P3 WRITES: authenticated users cannot create generated artifacts", async () => {
  await assert.rejects(
    () => userA.collection("business_facts").create({ organization: ids.orgA, client: ids.clientA, website: ids.websiteA, fact_type: "service", label: "Injected", value: "Injected", source: "manual", created_at: NOW() }),
    (error) => error.status === 403 || error.status === 404,
  );
  await assert.rejects(
    () => userA.collection("keywords").create({ organization: ids.orgA, client: ids.clientA, website: ids.websiteA, strategy_version: ids.version1, keyword: "injected", normalized_keyword: "injected", language: "en", source: "manual", status: "discovered", created_at: NOW() }),
    (error) => error.status === 403 || error.status === 404,
  );
});

after(async () => {
  if (!admin) return;
  const failures = [];
  const remove = async (collection, id) => {
    if (!id) return;
    try { await admin.collection(collection).delete(id); }
    catch (error) { if (error.status !== 404) failures.push(`${collection}/${id}: ${error.message}`); }
  };

  // Break the intentional keyword↔cluster cycle before deleting either side.
  for (const id of created.get("keywords") || []) {
    try { await admin.collection("keywords").update(id, { cluster: "" }); } catch {}
  }
  for (const id of created.get("topic_clusters") || []) {
    try { await admin.collection("topic_clusters").update(id, { pillar_keyword: "" }); } catch {}
  }

  // Delete only IDs created by this suite, in dependency order.
  const order = ["ai_usage", "content_plan_items", "content_plans", "cannibalization_issues", "content_opportunities", "keyword_page_mappings", "keywords", "topic_clusters", "business_facts", "strategy_versions", "strategy_jobs"];
  for (const collection of order) {
    for (const id of [...(created.get(collection) || [])].reverse()) await remove(collection, id);
  }
  for (const id of [ids.pageA2, ids.pageA]) await remove("website_pages", id);
  for (const id of [ids.userB, ids.userA]) await remove("users", id);
  for (const id of [ids.websiteB, ids.websiteA]) await remove("websites", id);
  for (const id of [ids.clientB, ids.clientA]) await remove("clients", id);
  for (const id of [ids.orgB, ids.orgA]) await remove("organizations", id);
  assert.deepEqual(failures, [], `fixture cleanup failed:\n${failures.join("\n")}`);
});
