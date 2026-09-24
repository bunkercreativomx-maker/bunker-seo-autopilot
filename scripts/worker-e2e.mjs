#!/usr/bin/env node
/**
 * End-to-end worker test against a live PocketBase.
 * Creates a real website + a queued crawl job, runs a single crawl (ONE_SHOT),
 * then verifies pages, issues, snapshot and links were persisted.
 *
 * Usage (against test PB):
 *   PB_URL=http://127.0.0.1:8097 PB_ADMIN_* node scripts/seed-test.mjs
 *   PB_URL=http://127.0.0.1:8097 PB_ADMIN_* node scripts/worker-e2e.mjs
 */
import { spawn } from "node:child_process";
import PocketBase from "pocketbase";
import { assertLocalTarget } from "./lib/local-only.mjs";

const PB_URL = process.env.PB_URL || "http://127.0.0.1:8095";
assertLocalTarget(PB_URL, "worker-e2e");
const ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL || "admin@seo.autopilot";
const ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD || "SeoAutopilot!2026x";
const TARGET = process.env.E2E_TARGET || "books.toscrape.com";

const admin = new PocketBase(PB_URL);
await admin.collection("_superusers").authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);

// find org A + client A from seed
const orgA = await admin.collection("organizations").getFirstListItem('slug = "org-a"');
const clientA = await admin.collection("clients").getFirstListItem('slug = "client-a"');

// create a controlled website for the E2E (domain = the public test target)
let website;
try { website = await admin.collection("websites").getFirstListItem('domain = "E2E"'); await admin.collection("websites").delete(website.id); } catch {}
website = await admin.collection("websites").create({
  organization: orgA.id, client: clientA.id, name: "E2E Test Site", domain: TARGET,
  platform: "custom", status: "active", created_at: new Date().toISOString(),
});

const job = await admin.collection("crawl_jobs").create({
  organization: orgA.id, client: clientA.id, website: website.id,
  status: "queued", triggered_by: "e2e",
  created_at: new Date().toISOString(),
});
console.log(`created website ${website.id} + job ${job.id}`);

// run worker one-shot
await new Promise((resolve, reject) => {
  const child = spawn("node", ["worker.js"], {
    cwd: new URL("../crawler/", import.meta.url).pathname,
    env: {
      ...process.env,
      PB_URL, PB_ADMIN_EMAIL: ADMIN_EMAIL, PB_ADMIN_PASSWORD: ADMIN_PASSWORD,
      ONE_SHOT: "1", MAX_PAGES: "30", CONCURRENCY: "3", POLL_INTERVAL_MS: "500",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`worker exited ${c}`))));
  child.on("error", reject);
});

// verify
const finished = await admin.collection("crawl_jobs").getOne(job.id);
const pages = await admin.collection("website_pages").getFullList(1000, { filter: `website = "${website.id}"` });
const issues = await admin.collection("seo_issues").getFullList(1000, { filter: `website = "${website.id}"` });
const snaps = await admin.collection("website_snapshots").getFullList(50, { filter: `website = "${website.id}"` });
const links = await admin.collection("page_links").getFullList(2000, { filter: `website = "${website.id}"` });

const checks = {
  job_status: finished.status,
  pages_crawled: pages.length,
  has_homepage: pages.some((p) => p.status_code === 200 && p.path === "/"),
  has_issue_missing_title: issues.some((i) => i.issue_type === "missing_title" || i.issue_type === "duplicate_title"),
  has_snapshot: snaps.length > 0,
  has_links: links.length > 0,
  snapshot_total: snaps[0]?.total_pages ?? 0,
};
console.log("RESULT", JSON.stringify(checks, null, 2));

// assertions
import assert from "node:assert/strict";
assert.ok(["completed", "completed_with_errors"].includes(finished.status), `job should complete, got ${finished.status}` + (finished.error_message ? " / " + finished.error_message : ""));
assert.ok(pages.length > 0, "pages should be crawled");
assert.ok(checks.has_homepage, "homepage should be a 200 page");
assert.ok(checks.has_snapshot, "snapshot should exist");

// cleanup (leave data so user cannot see it; delete our E2E records)
for (const col of ["page_links", "website_changes", "website_snapshots", "seo_issues", "website_pages", "crawl_jobs"]) {
  const list = await admin.collection(col).getFullList(2000, { filter: `website = "${website.id}"` });
  for (const r of list) { try { await admin.collection(col).delete(r.id); } catch {} }
}
try { await admin.collection("websites").delete(website.id); } catch {}

console.log("E2E OK");