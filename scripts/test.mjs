#!/usr/bin/env node
/**
 * Phase 1 test suite — runs against a live PocketBase instance.
 * Verifies auth, CRUD, multi-website-per-client, persistence, activity logging,
 * and — critically — TENANT ISOLATION at the backend level.
 *
 * Prereq: run `node scripts/setup-pocketbase.mjs` then `node scripts/seed-test.mjs`.
 * Usage: node --test scripts/test.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import PocketBase from "pocketbase";
import { assertLocalTarget } from "./lib/local-only.mjs";

const PB_URL = process.env.PB_URL || "http://127.0.0.1:8095";
assertLocalTarget(PB_URL, "test");
const ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL || "admin@seo.autopilot";
const ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD || "SeoAutopilot!2026x";
const EMAIL_A = "admin-a@test.local";
const EMAIL_B = "admin-b@test.local";
const PASS = "TestPass!2026";

let admin, userA, userB, ids;

before(async () => {
  admin = new PocketBase(PB_URL);
  await admin.collection("_superusers").authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);
  userA = new PocketBase(PB_URL);
  await userA.collection("users").authWithPassword(EMAIL_A, PASS);
  userB = new PocketBase(PB_URL);
  await userB.collection("users").authWithPassword(EMAIL_B, PASS);

  // Read seeded ids.
  const orgA = await admin.collection("organizations").getFirstListItem('slug = "org-a"');
  const orgB = await admin.collection("organizations").getFirstListItem('slug = "org-b"');
  const clientA = await admin.collection("clients").getFirstListItem('slug = "client-a"');
  const clientB = await admin.collection("clients").getFirstListItem('slug = "client-b"');
  const websites = await admin.collection("websites").getFullList(200, { filter: 'client = "' + clientA.id + '"' });
  ids = { orgA: orgA.id, orgB: orgB.id, clientA: clientA.id, clientB: clientB.id, websites };
});

test("AUTH: valid credentials log in", () => {
  assert.ok(userA.authStore.isValid);
  assert.ok(userB.authStore.isValid);
});

test("AUTH: invalid credentials are rejected", async () => {
  const bad = new PocketBase(PB_URL);
  await assert.rejects(
    () => bad.collection("users").authWithPassword(EMAIL_A, "wrong-password"),
    (e) => e.status === 400
  );
});

test("CLIENTS: user A can list only its own org's clients", async () => {
  const clients = await userA.collection("clients").getFullList(200);
  assert.ok(clients.length >= 1);
  for (const c of clients) {
    assert.equal(c.organization, ids.orgA, "user A must only see org A clients");
  }
});

test("TENANT ISOLATION: user A cannot read client B", async () => {
  await assert.rejects(
    () => userA.collection("clients").getOne(ids.clientB),
    (e) => e.status === 404 || e.status === 403
  );
});

test("TENANT ISOLATION: user B cannot read client A", async () => {
  await assert.rejects(
    () => userB.collection("clients").getOne(ids.clientA),
    (e) => e.status === 404 || e.status === 403
  );
});

test("TENANT ISOLATION: user A cannot list org B clients", async () => {
  const clients = await userA.collection("clients").getFullList(200);
  const leaked = clients.filter((c) => c.organization === ids.orgB);
  assert.equal(leaked.length, 0, "no org B clients may leak to user A");
});

test("WEBSITES: multiple websites per client work", () => {
  assert.ok(ids.websites.length >= 2, "client A should have at least 2 websites");
});

test("WEBSITES: user A sees both websites of client A", async () => {
  const sites = await userA.collection("websites").getFullList(200, { filter: 'client = "' + ids.clientA + '"' });
  assert.ok(sites.length >= 2);
});

test("TENANT ISOLATION: user A cannot read org B website", async () => {
  const orgBWebsites = await admin.collection("websites").getFullList(200, { filter: 'organization = "' + ids.orgB + '"' });
  if (orgBWebsites.length === 0) {
    // create one to prove isolation
    const w = await admin.collection("websites").create({
      organization: ids.orgB,
      client: ids.clientB,
      name: "Website B",
      domain: "website-b.com",
      platform: "custom",
      status: "active",
      created_at: new Date().toISOString(),
    });
    orgBWebsites.push(w);
  }
  for (const w of orgBWebsites) {
    await assert.rejects(
      () => userA.collection("websites").getOne(w.id),
      (e) => e.status === 404 || e.status === 403
    );
  }
});

test("CRUD: user A can create a client in its own org", async () => {
  const c = await userA.collection("clients").create({
    organization: ids.orgA,
    business_name: "CRUD Test Client",
    slug: "crud-test-client",
    status: "active",
    created_at: new Date().toISOString(),
  });
  assert.ok(c.id);
  // cleanup
  await admin.collection("clients").delete(c.id);
});

test("CRUD: user A can edit its own client", async () => {
  const c = await userA.collection("clients").create({
    organization: ids.orgA,
    business_name: "Edit Test",
    slug: "edit-test",
    status: "active",
    created_at: new Date().toISOString(),
  });
  const updated = await userA.collection("clients").update(c.id, { business_name: "Edit Test Updated" });
  assert.equal(updated.business_name, "Edit Test Updated");
  await admin.collection("clients").delete(c.id);
});

test("CRUD: user A can create a website under its own client", async () => {
  const w = await userA.collection("websites").create({
    organization: ids.orgA,
    client: ids.clientA,
    name: "CRUD Website",
    domain: "crud-website.com",
    platform: "react",
    status: "active",
    created_at: new Date().toISOString(),
  });
  assert.ok(w.id);
  await admin.collection("websites").delete(w.id);
});

test("TENANT ISOLATION: user A cannot create a client in org B", async () => {
  await assert.rejects(
    () => userA.collection("clients").create({
      organization: ids.orgB,
      business_name: "Sneaky",
      slug: "sneaky",
      status: "active",
      created_at: new Date().toISOString(),
    }),
    (e) => e.status === 400 || e.status === 403
  );
});

test("ACTIVITY: activity logs are written and scoped to org", async () => {
  const logs = await userA.collection("activity_logs").getFullList(200);
  // Regression: this test used to pass with an EMPTY log. The login + client
  // writes done above must have produced server-side (pb_hooks) entries.
  assert.ok(logs.length > 0, "activity logging must produce entries (was silently empty before)");
  assert.ok(logs.some((l) => l.action === "USER_LOGIN"), "login is logged");
  for (const l of logs) {
    assert.equal(l.organization, ids.orgA, "user A must only see org A activity");
  }
});

test("PERSISTENCE: data survives (re-read from a fresh client)", async () => {
  const fresh = new PocketBase(PB_URL);
  await fresh.collection("users").authWithPassword(EMAIL_A, PASS);
  const clients = await fresh.collection("clients").getFullList(200);
  assert.ok(clients.some((c) => c.slug === "client-a"), "client-a persists across sessions");
});

after(async () => {
  // nothing to tear down; seed script handles cleanup on next run
});
