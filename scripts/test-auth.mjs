#!/usr/bin/env node
/**
 * Auth-architecture regression tests (Phase 4 auth fix).
 *
 * Proves that every normal user-facing operation works WITHOUT the global
 * PocketBase superuser: each action below is executed with a regular user's
 * token against the same endpoints/rules the web app uses. The superuser is
 * used ONLY to create/clean fixtures and to read back results.
 *
 * Also verifies: cross-tenant / cross-client isolation, tampered tenant ids,
 * viewer/client role limits, unauthenticated access, privilege-escalation
 * guards, forged activity logs, logout token revocation, and that the web app
 * source contains no superuser dependency.
 *
 * Prereq: PocketBase running with --hooksDir=<repo>/pb_hooks and the schema
 * applied (node scripts/setup-pocketbase.mjs).
 * Usage:  PB_URL=http://127.0.0.1:8097 PB_ADMIN_EMAIL=... PB_ADMIN_PASSWORD=... node --test scripts/test-auth.mjs
 * LOCAL ONLY (guarded). Creates uniquely tagged fixtures and deletes only them.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import PocketBase from "pocketbase";
import { randomUUID } from "node:crypto";
import { assertLocalTarget } from "./lib/local-only.mjs";

const PB_URL = process.env.PB_URL || "http://127.0.0.1:8097";
assertLocalTarget(PB_URL, "test-auth");
const ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) throw new Error("PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD required (fixtures only)");
const PASS = "AuthTest!2026x";
const TAG = `au-${randomUUID().slice(0, 8)}`;
const NOW = () => new Date().toISOString();
const REPO = new URL("..", import.meta.url).pathname;

let admin; // fixtures + read-back ONLY
const ids = {};
const users = {}; // name -> { pb, id }

async function login(email) {
  const pb = new PocketBase(PB_URL);
  pb.autoCancellation(false);
  await pb.collection("users").authWithPassword(email, PASS);
  return pb;
}

async function op(pb, path, body) {
  return pb.send(`/api/bsa/${path}`, { method: "POST", body, requestKey: null });
}

function rejectsWith(promise, statuses) {
  return assert.rejects(promise, (e) => statuses.includes(e.status), `expected HTTP ${statuses.join("/")}`);
}

async function logs(filter) {
  return admin.collection("activity_logs").getFullList({ filter });
}

async function makeArticle(t, extra = {}) {
  const a = await admin.collection("articles").create({
    ...t, content_type: "blog_article", status: "awaiting_approval", language: "es", title: "Guía de paneles",
    slug: "guia-paneles", seo_title: "Guía", meta_description: "Meta", excerpt: "Resumen",
    content: "# Guía de paneles\n\nContenido revisado.", qa_status: "PASS", fact_check_status: "passed",
    flags: [], current_version: 1, generation_key: `${TAG}-${randomUUID().slice(0, 6)}`, ...extra,
  });
  await admin.collection("article_versions").create({ ...t, article: a.id, version: 1, title: a.title, content: a.content, seo_title: a.seo_title, meta_description: a.meta_description, excerpt: a.excerpt, slug: a.slug, change_type: "ai_generation", created_at: NOW() });
  return a;
}

before(async () => {
  admin = new PocketBase(PB_URL);
  admin.autoCancellation(false);
  await admin.collection("_superusers").authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);

  const org = (n) => admin.collection("organizations").create({ name: `${TAG} ${n}`, slug: `${TAG}-${n}`.toLowerCase(), status: "active", created_at: NOW() });
  const orgA = await org("A");
  const orgB = await org("B");
  const client = (o, n) => admin.collection("clients").create({ organization: o, business_name: `${TAG} ${n}`, slug: `${TAG}-${n}`.toLowerCase(), primary_language: "es", status: "active", created_at: NOW() });
  const clientA = await client(orgA.id, "ca");
  const clientA2 = await client(orgA.id, "ca2");
  const clientB = await client(orgB.id, "cb");
  const site = (o, c, n) => admin.collection("websites").create({ organization: o, client: c, name: `${TAG} ${n}`, domain: `${TAG}-${n}.example.test`, platform: "custom", primary_language: "es", status: "active", created_at: NOW() });
  const webA = await site(orgA.id, clientA.id, "wa");
  const webA2 = await site(orgA.id, clientA2.id, "wa2");
  const webB = await site(orgB.id, clientB.id, "wb");
  Object.assign(ids, { orgA: orgA.id, orgB: orgB.id, clientA: clientA.id, clientA2: clientA2.id, clientB: clientB.id, webA: webA.id, webA2: webA2.id, webB: webB.id });

  const mk = async (name, organization, role) => {
    const u = await admin.collection("users").create({ email: `${TAG}-${name}@test.local`, password: PASS, passwordConfirm: PASS, name: `${TAG} ${name}`, organization, role, status: "active" });
    users[name] = { id: u.id, pb: await login(`${TAG}-${name}@test.local`) };
  };
  await mk("editorA", orgA.id, "editor");
  await mk("adminA", orgA.id, "admin");
  await mk("viewerA", orgA.id, "viewer");
  await mk("clientRoleA", orgA.id, "client");
  await mk("editorB", orgB.id, "editor");

  const A = { organization: orgA.id, client: clientA.id, website: webA.id };
  const A2 = { organization: orgA.id, client: clientA2.id, website: webA2.id };
  const B = { organization: orgB.id, client: clientB.id, website: webB.id };
  ids.A = A; ids.A2 = A2; ids.B = B;
  const sv = async (t) => (await admin.collection("strategy_versions").create({ ...t, version: 1, summary: "v1", generated_at: NOW(), created_at: NOW(), updated_at: NOW() })).id;
  const svA = await sv(A);
  const svA2 = await sv(A2);
  const svB = await sv(B);
  const opp = async (t, s, extra = {}) => (await admin.collection("content_opportunities").create({ ...t, strategy_version: s, opportunity_type: "create", recommended_page_type: "blog_article", recommended_url: "/blog/x", title_suggestion: "Paneles solares", reason: "gap", priority: "high", status: "approved", evidence: [{ type: "fixture" }], created_at: NOW(), updated_at: NOW(), ...extra })).id;
  ids.oppA = await opp(A, svA);
  ids.oppA_2 = await opp(A, svA);
  ids.oppA_proposed = await opp(A, svA, { status: "proposed" });
  ids.oppA2 = await opp(A2, svA2);
  ids.oppB = await opp(B, svB);
  ids.artA = (await makeArticle(A)).id;
  ids.artA_reject = (await makeArticle(A)).id;
  ids.artA_revise = (await makeArticle(A)).id;
  ids.artB = (await makeArticle(B)).id;
});

after(async () => {
  if (!admin) return;
  for (const orgId of [ids.orgA, ids.orgB].filter(Boolean)) {
    const filter = `organization = "${orgId}"`;
    for (const c of ["activity_logs", "content_jobs", "article_versions", "articles", "crawl_jobs", "strategy_jobs", "content_opportunities", "strategy_versions"]) {
      const rows = await admin.collection(c).getFullList({ filter, fields: "id" }).catch(() => []);
      for (const r of rows) await admin.collection(c).delete(r.id).catch(() => {});
    }
    for (const c of ["users", "websites", "clients"]) {
      const rows = await admin.collection(c).getFullList({ filter, fields: "id" }).catch(() => []);
      for (const r of rows) await admin.collection(c).delete(r.id).catch(() => {});
    }
    await admin.collection("organizations").delete(orgId).catch(() => {});
  }
});

// ================================================================= no admin dependency in the web app
test("AUTH: the Next.js app has no superuser dependency (no PB_ADMIN_*, no _superusers, no adminAuth)", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|mjs)$/.test(name)) {
        const text = readFileSync(full, "utf8");
        if (/PB_ADMIN_EMAIL|PB_ADMIN_PASSWORD|_superusers|adminAuth|createAdminClient/.test(text)) offenders.push(full.replace(REPO, ""));
      }
    }
  };
  walk(join(REPO, "src"));
  assert.deepEqual(offenders, [], "web app source must not reference superuser credentials");
});

// ================================================================= generate content
test("GENERATE: works with a regular editor token (no superuser) and logs CONTENT_GENERATION_STARTED", async () => {
  const r = await op(users.editorA.pb, "content/generate", { websiteId: ids.webA, source: { kind: "opportunity", id: ids.oppA }, inputs: { content_type: "blog_article", primary_keyword: "paneles solares", language: "es" } });
  assert.equal(r.created, true);
  assert.equal(r.job.status, "queued");
  const article = await admin.collection("articles").getOne(r.article.id);
  assert.deepEqual([article.organization, article.client, article.website], [ids.orgA, ids.clientA, ids.webA]);
  assert.equal(article.created_by, users.editorA.id);
  const job = await admin.collection("content_jobs").getOne(r.job.id);
  assert.equal(job.triggered_by, users.editorA.id);
  const entries = await logs(`entity_id = "${article.id}" && action = "CONTENT_GENERATION_STARTED"`);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].user, users.editorA.id);
  assert.equal(entries[0].organization, ids.orgA);
  ids.generated = article.id;
});

test("GENERATE: cross-tenant and cross-client sources are blocked; tampered ids never create records", async () => {
  const inputs = { content_type: "blog_article", primary_keyword: "paneles solares", language: "es" };
  // Org B user targeting org A website/opportunity
  await rejectsWith(op(users.editorB.pb, "content/generate", { websiteId: ids.webA, source: { kind: "opportunity", id: ids.oppA_2 }, inputs }), [404]);
  // Own website + other org's opportunity
  await rejectsWith(op(users.editorA.pb, "content/generate", { websiteId: ids.webA, source: { kind: "opportunity", id: ids.oppB }, inputs }), [404]);
  // Same org, but opportunity of ANOTHER client paired with this client's website
  await rejectsWith(op(users.editorA.pb, "content/generate", { websiteId: ids.webA, source: { kind: "opportunity", id: ids.oppA2 }, inputs }), [404]);
  // Injected tenant ids in the body are ignored (tenant comes from the token + records)
  await rejectsWith(op(users.editorB.pb, "content/generate", { websiteId: ids.webA, organization: ids.orgA, client: ids.clientA, source: { kind: "opportunity", id: ids.oppA_2 }, inputs }), [404]);
  // Not approved
  await rejectsWith(op(users.editorA.pb, "content/generate", { websiteId: ids.webA, source: { kind: "opportunity", id: ids.oppA_proposed }, inputs }), [409]);
  const created = await admin.collection("articles").getFullList({ filter: `content_opportunity = "${ids.oppA_2}" || content_opportunity = "${ids.oppB}" || content_opportunity = "${ids.oppA2}" || content_opportunity = "${ids.oppA_proposed}"` });
  assert.equal(created.length, 0);
});

test("GENERATE: viewer and client roles cannot generate; unauthenticated is rejected", async () => {
  const body = { websiteId: ids.webA, source: { kind: "opportunity", id: ids.oppA_2 }, inputs: { content_type: "blog_article", primary_keyword: "paneles solares", language: "es" } };
  await rejectsWith(op(users.viewerA.pb, "content/generate", body), [403]);
  await rejectsWith(op(users.clientRoleA.pb, "content/generate", body), [403]);
  await rejectsWith(op(new PocketBase(PB_URL), "content/generate", body), [401]);
  // A superuser token is not a user session: endpoints refuse it too.
  await rejectsWith(op(admin, "content/generate", body), [401, 403]);
});

// ================================================================= edit / restore
test("EDIT: works with an editor token, writes a version + ARTICLE_EDITED; cross-tenant edit blocked", async () => {
  const r = await op(users.editorA.pb, "content/edit", { articleId: ids.artA, fields: { content: "# Guía de paneles\n\nContenido editado." }, reason: "Ajuste" });
  assert.equal(r.changed, true);
  assert.equal(r.version, 2);
  const a = await admin.collection("articles").getOne(ids.artA);
  assert.equal(a.qa_status, "stale");
  const versions = await admin.collection("article_versions").getFullList({ filter: `article = "${ids.artA}"`, sort: "version" });
  assert.deepEqual(versions.map((v) => v.change_type), ["ai_generation", "manual_edit"]);
  assert.equal(versions[1].created_by, users.editorA.id);
  assert.equal((await logs(`entity_id = "${ids.artA}" && action = "ARTICLE_EDITED"`)).length, 1);

  await rejectsWith(op(users.editorB.pb, "content/edit", { articleId: ids.artA, fields: { title: "hack" } }), [404]);
  await rejectsWith(op(users.viewerA.pb, "content/edit", { articleId: ids.artA, fields: { title: "viewer edit" } }), [403]);
  await rejectsWith(op(users.clientRoleA.pb, "content/edit", { articleId: ids.artA, fields: { title: "client edit" } }), [403]);
  assert.equal((await admin.collection("articles").getOne(ids.artA)).title, "Guía de paneles");
});

test("RESTORE: works with an editor token, creates a new version, logs ARTICLE_VERSION_RESTORED; cross-tenant blocked", async () => {
  const r = await op(users.editorA.pb, "content/restore", { articleId: ids.artA, version: 1 });
  assert.equal(r.version, 3);
  const a = await admin.collection("articles").getOne(ids.artA);
  assert.equal(a.content, "# Guía de paneles\n\nContenido revisado.");
  assert.equal((await logs(`entity_id = "${ids.artA}" && action = "ARTICLE_VERSION_RESTORED"`)).length, 1);
  await rejectsWith(op(users.editorB.pb, "content/restore", { articleId: ids.artA, version: 1 }), [404]);
  await rejectsWith(op(users.editorA.pb, "content/restore", { articleId: ids.artB, version: 1 }), [404]);
});

// ================================================================= approve / reject / revision
test("APPROVE: editor approves without superuser; viewer/client/other org cannot; invalid transition refused", async () => {
  // artA was edited+restored -> draft/stale -> not approvable
  await rejectsWith(op(users.editorA.pb, "content/approve", { articleId: ids.artA }), [409]);
  await admin.collection("articles").update(ids.artA, { status: "awaiting_approval", qa_status: "PASS", fact_check_status: "passed" });
  await rejectsWith(op(users.viewerA.pb, "content/approve", { articleId: ids.artA }), [403]);
  await rejectsWith(op(users.clientRoleA.pb, "content/approve", { articleId: ids.artA }), [403]);
  await rejectsWith(op(users.editorB.pb, "content/approve", { articleId: ids.artA }), [404]);
  await rejectsWith(op(users.editorA.pb, "content/approve", { articleId: ids.artB }), [404]);
  const r = await op(users.editorA.pb, "content/approve", { articleId: ids.artA });
  assert.equal(r.status, "approved");
  const a = await admin.collection("articles").getOne(ids.artA);
  assert.equal(a.approved_by, users.editorA.id);
  assert.equal(a.provenance.auto_publish_allowed, false);
  const entry = (await logs(`entity_id = "${ids.artA}" && action = "ARTICLE_APPROVED"`))[0];
  assert.equal(entry.user, users.editorA.id);
  assert.equal((await admin.collection("articles").getOne(ids.artB)).status, "awaiting_approval", "other tenant untouched");
});

test("REJECT: editor rejects without superuser; reason required; cross-tenant blocked", async () => {
  await rejectsWith(op(users.editorA.pb, "content/reject", { articleId: ids.artA_reject, reason: "" }), [400]);
  await rejectsWith(op(users.editorB.pb, "content/reject", { articleId: ids.artA_reject, reason: "Fuera de estrategia" }), [404]);
  await rejectsWith(op(users.viewerA.pb, "content/reject", { articleId: ids.artA_reject, reason: "Fuera de estrategia" }), [403]);
  const r = await op(users.editorA.pb, "content/reject", { articleId: ids.artA_reject, reason: "Fuera de estrategia" });
  assert.equal(r.status, "rejected");
  const entry = (await logs(`entity_id = "${ids.artA_reject}" && action = "ARTICLE_REJECTED"`))[0];
  assert.equal(entry.metadata.reason, "Fuera de estrategia");
  // Approved content cannot be rejected
  await rejectsWith(op(users.editorA.pb, "content/reject", { articleId: ids.artA, reason: "Cambio de idea" }), [409]);
});

test("REVISION: editor requests revision without superuser; job queued as the user; cross-tenant blocked", async () => {
  await rejectsWith(op(users.editorB.pb, "content/revision", { articleId: ids.artA_revise, instruction: "Añade FAQs" }), [404]);
  await rejectsWith(op(users.clientRoleA.pb, "content/revision", { articleId: ids.artA_revise, instruction: "Añade FAQs" }), [403]);
  const job = await op(users.editorA.pb, "content/revision", { articleId: ids.artA_revise, instruction: "Añade FAQs" });
  assert.equal(job.mode, "revision");
  const stored = await admin.collection("content_jobs").getOne(job.id);
  assert.deepEqual([stored.organization, stored.client, stored.website, stored.triggered_by], [ids.orgA, ids.clientA, ids.webA, users.editorA.id]);
  assert.equal((await admin.collection("articles").getOne(ids.artA_revise)).status, "needs_revision");
  assert.equal((await logs(`entity_id = "${ids.artA_revise}" && action = "REVISION_REQUESTED"`)).length, 1);
  // A second concurrent request is refused while the job is active
  await rejectsWith(op(users.editorA.pb, "content/revision", { articleId: ids.artA_revise, instruction: "Otra" }), [409]);
});

// ================================================================= direct REST bypass attempts
test("REST: users cannot write content/job/activity collections directly, even inside their org", async () => {
  const pb = users.adminA.pb;
  await rejectsWith(pb.collection("articles").update(ids.artA_revise, { status: "approved" }), [403, 404]);
  await rejectsWith(pb.collection("articles").create({ ...ids.A, content_type: "blog_article", status: "approved", language: "es" }), [400, 403]);
  await rejectsWith(pb.collection("content_jobs").create({ ...ids.A, status: "queued", mode: "generate", triggered_by: users.adminA.id }), [400, 403]);
  await rejectsWith(pb.collection("article_versions").create({ ...ids.A, article: ids.artA, version: 99, change_type: "manual_edit" }), [400, 403]);
  await rejectsWith(pb.collection("activity_logs").create({ organization: ids.orgA, action: "ARTICLE_APPROVED", entity_id: ids.artA_revise }), [400, 403]);
  assert.equal((await logs(`entity_id = "${ids.artA_revise}" && action = "ARTICLE_APPROVED"`)).length, 0, "no forged activity");
});

test("TAMPER: clients/websites/crawl & strategy jobs cannot be pointed at another tenant", async () => {
  const pb = users.editorA.pb;
  // Move own client into another org
  await rejectsWith(pb.collection("clients").update(ids.clientA, { organization: ids.orgB }), [400, 403, 404]);
  assert.equal((await admin.collection("clients").getOne(ids.clientA)).organization, ids.orgA);
  // Create a website in own org that belongs to another org's client
  await rejectsWith(pb.collection("websites").create({ organization: ids.orgA, client: ids.clientB, name: "x", domain: "x.test", platform: "custom", status: "active" }), [400, 403]);
  // Re-point own website to a client of another org / another tenant
  await rejectsWith(pb.collection("websites").update(ids.webA, { client: ids.clientB }), [400, 403, 404]);
  await rejectsWith(pb.collection("websites").update(ids.webA, { organization: ids.orgB }), [400, 403, 404]);
  assert.equal((await admin.collection("websites").getOne(ids.webA)).client, ids.clientA);
  // Crawl a website of another org while claiming own org
  await rejectsWith(pb.collection("crawl_jobs").create({ organization: ids.orgA, client: ids.clientA, website: ids.webB, status: "queued", triggered_by: users.editorA.id }), [400, 403]);
  // Crawl job attributed to someone else
  await rejectsWith(pb.collection("crawl_jobs").create({ organization: ids.orgA, client: ids.clientA, website: ids.webA, status: "queued", triggered_by: users.adminA.id }), [400, 403]);
  // Strategy job for another org's website
  await rejectsWith(pb.collection("strategy_jobs").create({ organization: ids.orgA, client: ids.clientB, website: ids.webB, status: "queued", step: "queued", progress: 0, triggered_by: users.editorA.id }), [400, 403]);
  // Legit crawl job still works (and is logged server-side)
  const job = await pb.collection("crawl_jobs").create({ organization: ids.orgA, client: ids.clientA, website: ids.webA, status: "queued", triggered_by: users.editorA.id });
  assert.equal((await logs(`entity_id = "${job.id}" && action = "WEBSITE_ANALYSIS_STARTED"`)).length, 1);
});

test("ESCALATION: users cannot change their own role/org/status; admins cannot grant super_admin or poach", async () => {
  const self = users.editorA;
  await rejectsWith(self.pb.collection("users").update(self.id, { role: "admin" }), [400, 403, 404]);
  await rejectsWith(self.pb.collection("users").update(self.id, { organization: ids.orgB }), [400, 403, 404]);
  await rejectsWith(self.pb.collection("users").update(self.id, { status: "active", role: "super_admin" }), [400, 403, 404]);
  const me = await admin.collection("users").getOne(self.id);
  assert.deepEqual([me.role, me.organization], ["editor", ids.orgA]);
  // Profile edits still work
  await self.pb.collection("users").update(self.id, { name: `${TAG} renamed` });
  // Non-admin cannot manage other members
  await rejectsWith(self.pb.collection("users").update(users.viewerA.id, { role: "admin" }), [400, 403, 404]);
  // Org admin cannot grant super_admin or move a member to another org
  await rejectsWith(users.adminA.pb.collection("users").update(users.viewerA.id, { role: "super_admin" }), [400, 403]);
  await rejectsWith(users.adminA.pb.collection("users").update(users.viewerA.id, { organization: ids.orgB }), [400, 403, 404]);
  // Org admin cannot create a user in another org
  await rejectsWith(users.adminA.pb.collection("users").create({ email: `${TAG}-poach@test.local`, password: PASS, passwordConfirm: PASS, organization: ids.orgB, role: "admin", status: "active" }), [400, 403]);
  // Other org cannot touch org A members
  await rejectsWith(users.editorB.pb.collection("users").update(users.viewerA.id, { role: "admin" }), [403, 404]);
  assert.equal((await admin.collection("users").getOne(users.viewerA.id)).role, "viewer");
});

// ================================================================= strategy + organization
test("STRATEGY: record edits via user token validate website/client relationship and log", async () => {
  await op(users.editorA.pb, "strategy/record", { websiteId: ids.webA, recordId: ids.oppA_proposed, collection: "opportunities", operation: "change_priority", value: "low" });
  assert.equal((await admin.collection("content_opportunities").getOne(ids.oppA_proposed)).priority, "low");
  assert.equal((await logs(`entity_id = "${ids.oppA_proposed}" && action = "STRATEGY_RECORD_UPDATED"`)).length, 1);
  // Same org, record of another client's website
  await rejectsWith(op(users.editorA.pb, "strategy/record", { websiteId: ids.webA, recordId: ids.oppA2, collection: "opportunities", operation: "approve" }), [404]);
  // Other org
  await rejectsWith(op(users.editorB.pb, "strategy/record", { websiteId: ids.webA, recordId: ids.oppA_proposed, collection: "opportunities", operation: "approve" }), [404]);
  await rejectsWith(op(users.viewerA.pb, "strategy/record", { websiteId: ids.webA, recordId: ids.oppA_proposed, collection: "opportunities", operation: "approve" }), [403]);
  assert.equal((await admin.collection("content_opportunities").getOne(ids.oppA_proposed)).status, "proposed");
});

test("ORGANIZATION: only org admins rename their own org (no superuser)", async () => {
  await rejectsWith(op(users.editorA.pb, "organization", { name: "Nope" }), [403]);
  await op(users.adminA.pb, "organization", { name: `${TAG} A renamed` });
  assert.equal((await admin.collection("organizations").getOne(ids.orgA)).name, `${TAG} A renamed`);
  assert.equal((await admin.collection("organizations").getOne(ids.orgB)).name, `${TAG} B`);
});

// ================================================================= activity logging
test("ACTIVITY: login / client / website mutations are logged server-side; tenants cannot read each other's logs", async () => {
  await login(`${TAG}-editorA@test.local`);
  const loginLogs = await logs(`user = "${users.editorA.id}" && action = "USER_LOGIN"`);
  assert.ok(loginLogs.length >= 1);
  const c = await users.editorA.pb.collection("clients").create({ organization: ids.orgA, business_name: `${TAG} new client`, slug: `${TAG}-new`, status: "active" });
  await users.editorA.pb.collection("clients").update(c.id, { industry: "solar" });
  const w = await users.editorA.pb.collection("websites").create({ organization: ids.orgA, client: c.id, name: "n", domain: `${TAG}-n.example.test`, platform: "custom", status: "active" });
  await users.editorA.pb.collection("websites").update(w.id, { name: "n2" });
  for (const [entity, action] of [[c.id, "CLIENT_CREATED"], [c.id, "CLIENT_UPDATED"], [w.id, "WEBSITE_CREATED"], [w.id, "WEBSITE_UPDATED"]]) {
    const rows = await logs(`entity_id = "${entity}" && action = "${action}"`);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].user, users.editorA.id, action);
    assert.equal(rows[0].organization, ids.orgA, action);
    assert.ok(rows[0].created_at, action);
  }
  // Tenant isolation of the log itself
  const visibleToB = await users.editorB.pb.collection("activity_logs").getFullList({ filter: `organization = "${ids.orgA}"` });
  assert.equal(visibleToB.length, 0);
  const visibleToA = await users.editorA.pb.collection("activity_logs").getFullList();
  assert.ok(visibleToA.length > 0 && visibleToA.every((l) => l.organization === ids.orgA));
});

test("STRATEGY GENERATED: worker completion of a strategy job is logged with the triggering user", async () => {
  const job = await users.editorA.pb.collection("strategy_jobs").create({ ...ids.A, status: "queued", step: "queued", progress: 0, triggered_by: users.editorA.id, created_at: NOW(), updated_at: NOW() });
  assert.equal((await logs(`entity_id = "${job.id}" && action = "STRATEGY_GENERATION_STARTED"`)).length, 1);
  await admin.collection("strategy_jobs").update(job.id, { status: "completed", progress: 100 }); // worker (superuser) completes it
  const done = await logs(`entity_id = "${job.id}" && action = "STRATEGY_GENERATED"`);
  assert.equal(done.length, 1);
  assert.equal(done[0].user, users.editorA.id);
});

// ================================================================= session security
test("SESSION: logout revokes every token of the user server-side", async () => {
  const email = `${TAG}-viewerA@test.local`;
  const s1 = await login(email);
  const s2 = await login(email);
  await s1.collection("users").authRefresh();
  await op(s1, "logout", {});
  await rejectsWith(s1.collection("users").authRefresh(), [401, 403, 404]);
  await rejectsWith(s2.collection("users").authRefresh(), [401, 403, 404]);
  assert.equal((await logs(`user = "${users.viewerA.id}" && action = "USER_LOGOUT"`)).length, 1);
  const s3 = await login(email); // new login works again
  await s3.collection("users").authRefresh();
});

test("SESSION: disabled accounts cannot perform operations", async () => {
  const u = await admin.collection("users").create({ email: `${TAG}-disabled@test.local`, password: PASS, passwordConfirm: PASS, organization: ids.orgA, role: "editor", status: "active" });
  const pb = await login(`${TAG}-disabled@test.local`);
  await admin.collection("users").update(u.id, { status: "disabled" });
  await rejectsWith(op(pb, "content/edit", { articleId: ids.artA_reject, fields: { title: "x" } }), [403]);
});
