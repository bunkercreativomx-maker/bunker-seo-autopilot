#!/usr/bin/env node
/**
 * Local Phase 3 worker E2E. Requires an already bootstrapped local PocketBase.
 * Seeds an isolated fixture, runs the real worker with ONE_SHOT=1/AI_PROVIDER=null,
 * verifies generated records + manual preservation + null metrics, then deletes
 * only records belonging to this fixture.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import PocketBase from "pocketbase";
import { assertLocalTarget } from "./lib/local-only.mjs";

const PB_URL = process.env.PB_URL || "http://127.0.0.1:8095";
assertLocalTarget(PB_URL, "strategy-worker-e2e");
const ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) throw new Error("PB_ADMIN_EMAIL and PB_ADMIN_PASSWORD are required");
const tag = `strategy-e2e-${randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();
const pb = new PocketBase(PB_URL);
const core = {};

async function remove(collection, id) {
  if (!id) return;
  try { await pb.collection(collection).delete(id); }
  catch (error) { if (error?.status !== 404) throw error; }
}

async function fixtureRecords(collection) {
  if (!core.website) return [];
  return pb.collection(collection).getFullList({ filter: `website = "${core.website}"`, requestKey: null });
}

async function cleanup() {
  if (core.website) {
    for (const keyword of await fixtureRecords("keywords")) {
      try { await pb.collection("keywords").update(keyword.id, { cluster: "" }); } catch {}
    }
    for (const cluster of await fixtureRecords("topic_clusters")) {
      try { await pb.collection("topic_clusters").update(cluster.id, { pillar_keyword: "" }); } catch {}
    }
    const order = ["ai_usage", "content_plan_items", "content_plans", "cannibalization_issues", "content_opportunities", "keyword_page_mappings", "keywords", "topic_clusters", "business_facts", "strategy_versions", "strategy_jobs", "page_links", "website_changes", "website_snapshots", "seo_issues", "website_pages"];
    for (const collection of order) {
      const records = await fixtureRecords(collection);
      for (const record of records.reverse()) await remove(collection, record.id);
    }
  }
  await remove("users", core.user);
  await remove("websites", core.website);
  await remove("clients", core.client);
  await remove("organizations", core.organization);
}

try {
  await pb.collection("_superusers").authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);
  const queued = await pb.collection("strategy_jobs").getList(1, 1, { filter: 'status = "queued"', requestKey: null });
  assert.equal(queued.totalItems, 0, "local PocketBase must not contain another queued strategy job");

  const org = await pb.collection("organizations").create({ name: `${tag} Org`, slug: `${tag}-org`, status: "active", created_at: now() });
  core.organization = org.id;
  const client = await pb.collection("clients").create({ organization: org.id, business_name: `${tag} HVAC`, slug: `${tag}-client`, services: "HVAC repair, furnace maintenance", primary_location: "El Paso", service_areas: "Socorro", primary_language: "en", country: "US", status: "active", created_at: now() });
  core.client = client.id;
  const website = await pb.collection("websites").create({ organization: org.id, client: client.id, name: `${tag} Site`, domain: `${tag}.example.test`, platform: "custom", primary_language: "en", country: "US", target_locations: "El Paso", status: "active", created_at: now() });
  core.website = website.id;
  const password = `E2e-${randomUUID()}!aA1`;
  const user = await pb.collection("users").create({ email: `${tag}@test.local`, password, passwordConfirm: password, organization: org.id, role: "admin", status: "active", emailVisibility: false });
  core.user = user.id;
  const base = { organization: org.id, client: client.id, website: website.id };
  const page1 = await pb.collection("website_pages").create({ ...base, url: `https://${tag}.example.test/hvac-repair`, normalized_url: `https://${tag}.example.test/hvac-repair`, path: "/hvac-repair", status_code: 200, indexable: true, title: "HVAC Repair", h1: "HVAC Repair", word_count: 700, created_at: now() });
  await pb.collection("website_pages").create({ ...base, url: `https://${tag}.example.test/services/hvac`, normalized_url: `https://${tag}.example.test/services/hvac`, path: "/services/hvac", status_code: 200, indexable: true, title: "HVAC Repair Services", h1: "HVAC Repair", word_count: 500, created_at: now() });
  await pb.collection("business_facts").create({ ...base, fact_type: "service", label: "Emergency service", value: "Emergency HVAC repair", source: "manual-e2e", verified: true, created_at: now(), updated_at: now() });

  const priorVersion = await pb.collection("strategy_versions").create({ ...base, version: 1, summary: "E2E manual baseline", generated_at: now(), generated_by: user.id, configuration: { fixture: tag }, created_at: now(), updated_at: now() });
  await pb.collection("keywords").create({
    ...base, strategy_version: priorVersion.id, keyword: "HVAC repair", normalized_keyword: "hvac repair", language: "en", country: "US",
    intent: "commercial", funnel_stage: "consideration", topic: "hvac repair", source: "manual", source_query: "HVAC repair",
    existing_target_page: page1.id, opportunity_type: "optimize", recommended_page_type: "existing_page",
    priority: "critical", status: "approved", search_volume: null, cpc: null, keyword_difficulty: null, metrics_source: "",
    evidence: { stable_key: "hvac-repair", fixture: tag }, manual_override: true, manual_fields: ["intent", "priority", "status"], overridden_by: user.id, overridden_at: now(), created_at: now(), updated_at: now(),
  });
  const job = await pb.collection("strategy_jobs").create({ ...base, status: "queued", step: "queued", progress: 0, triggered_by: user.id, configuration: { max_ai_calls_per_strategy: 0, max_keywords_per_strategy: 30, max_clusters: 10, max_opportunities: 20 }, created_at: now(), updated_at: now() });

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["worker.js"], {
      cwd: new URL("../strategy-worker/", import.meta.url).pathname,
      env: { ...process.env, PB_URL, PB_ADMIN_EMAIL: ADMIN_EMAIL, PB_ADMIN_PASSWORD: ADMIN_PASSWORD, AI_PROVIDER: "null", ONE_SHOT: "1", POLL_INTERVAL_MS: "250" },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`strategy worker exited ${code}`)));
  });

  const finished = await pb.collection("strategy_jobs").getOne(job.id);
  assert.equal(finished.status, "completed");
  const versions = await fixtureRecords("strategy_versions");
  const latestVersion = versions.sort((a, b) => b.version - a.version)[0];
  assert.equal(latestVersion.version, 2);
  const keywords = (await fixtureRecords("keywords")).filter((item) => item.strategy_version === latestVersion.id);
  const clusters = (await fixtureRecords("topic_clusters")).filter((item) => item.strategy_version === latestVersion.id);
  const mappings = (await fixtureRecords("keyword_page_mappings")).filter((item) => item.strategy_version === latestVersion.id);
  const opportunities = (await fixtureRecords("content_opportunities")).filter((item) => item.strategy_version === latestVersion.id);
  const plans = (await fixtureRecords("content_plans")).filter((item) => item.strategy_version === latestVersion.id);
  const actions = (await fixtureRecords("content_plan_items")).filter((item) => item.strategy_version === latestVersion.id);
  assert.ok(keywords.length > 0 && clusters.length > 0 && mappings.length > 0 && opportunities.length > 0 && plans.length === 1 && actions.length > 0);
  assert.ok(keywords.every((item) => item.search_volume === null && item.cpc === null && item.keyword_difficulty === null));
  const preserved = keywords.find((item) => item.normalized_keyword === "hvac repair");
  assert.equal(preserved.intent, "commercial");
  assert.equal(preserved.priority, "critical");
  assert.equal(preserved.status, "approved");
  assert.equal(preserved.manual_override, true);
  assert.equal((await fixtureRecords("ai_usage")).length, 0);
  console.log("STRATEGY E2E OK", JSON.stringify({ job: finished.status, version: latestVersion.version, keywords: keywords.length, clusters: clusters.length, opportunities: opportunities.length, manual_preserved: true, null_metrics: true }));
} finally {
  await cleanup();
}
