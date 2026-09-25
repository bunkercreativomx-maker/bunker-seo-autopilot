#!/usr/bin/env node
/**
 * Phase 6 integration tests — Search Console OAuth, sync, analytics and
 * tenant isolation against a LOCAL PocketBase (hooks loaded) and a loopback
 * Google mock (OAuth token/userinfo/revoke + Search Console API).
 *
 * Requires PocketBase started with:
 *   GSC_KEY_FILE=<32-char key file> GOOGLE_OAUTH_FILE=<json>
 *   GSC_GOOGLE_AUTH_URL/TOKEN_URL/USERINFO_URL/REVOKE_URL + GSC_API_BASE → http://127.0.0.1:3397
 *   --hooksDir=<repo>/pb_hooks
 * and GSC_KEY_FILE in this process env. LOCAL ONLY (guarded).
 * Uniquely tagged fixtures, deleted afterwards. Google is never contacted.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import PocketBase from "pocketbase";
import { randomUUID } from "node:crypto";
import { assertLocalTarget } from "./lib/local-only.mjs";
import { claimNextJob, processJob, scheduleDaily, analyze } from "../analytics-worker/src/engine.js";
import { loadKey, decrypt } from "../analytics-worker/src/secrets.js";
import { READONLY_SCOPE } from "../analytics-worker/src/google.js";

const PB_URL = process.env.PB_URL || "http://127.0.0.1:8097";
assertLocalTarget(PB_URL, "test-phase6");
const ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) throw new Error("PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD required");
const PORT = 3397;
const GOOGLE = `http://127.0.0.1:${PORT}`;
const PASS = `P6-${randomUUID()}`;
const TAG = `p6-${randomUUID().slice(0, 8)}`;
const NOW = () => new Date().toISOString();
const quiet = { log() {}, warn() {}, error() {} };
const WORKER_ENV = { ...process.env, GSC_GOOGLE_TOKEN_URL: `${GOOGLE}/token`, GSC_API_BASE: `${GOOGLE}/webmasters/v3`, GSC_WINDOW_DAYS: "7" };
const OAUTH = { client_id: "test-client", client_secret: "test-secret" };

// ---------------------------------------------------------------- Google mock
const LATEST = "2026-09-20";
const DOMAIN = "p6site.example.test";
const SITE_URL = `sc-domain:${DOMAIN}`;
const PAGE_A = `https://${DOMAIN}/servicios/instalacion`;
const PAGE_B = `https://${DOMAIN}/`;
function dayList(start, end) { const out = []; for (let d = start; d <= end; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) out.push(d); return out; }
/** Deterministic fake daily data (only for the mock property). */
function fakeRows(dimensions, start, end) {
  const rows = [];
  for (const d of dayList(start, end)) {
    const recent = d >= "2026-08-24";
    const qp = [
      ["instalacion paneles solares juarez", PAGE_A, recent ? 3 : 1, recent ? 60 : 40, 7.5],
      ["paneles solares para negocio juarez", PAGE_B, 0, recent ? 12 : 0, 11.2],
      ["tlaloc p6", PAGE_B, 2, 4, 1.1],
    ];
    if (dimensions.join() === "date") rows.push({ keys: [d], clicks: qp.reduce((a, r) => a + r[2], 0) + 1, impressions: qp.reduce((a, r) => a + r[3], 0) + 10, ctr: 0.05, position: 8.25 });
    else if (dimensions.join() === "date,page") { rows.push({ keys: [d, PAGE_A], clicks: qp[0][2], impressions: qp[0][3], ctr: qp[0][2] / qp[0][3], position: 7.5 }); rows.push({ keys: [d, PAGE_B], clicks: 3, impressions: 26, ctr: 3 / 26, position: 6.4 }); }
    else if (dimensions.join() === "date,query") for (const r of qp) { if (r[3]) rows.push({ keys: [d, r[0]], clicks: r[2], impressions: r[3], ctr: r[2] / r[3], position: r[4] }); }
    else if (dimensions.join() === "date,query,page") for (const r of qp) { if (r[3]) rows.push({ keys: [d, r[0], r[1]], clicks: r[2], impressions: r[3], ctr: r[2] / r[3], position: r[4] }); }
  }
  return rows;
}
const g = {
  codes: new Map(),        // code -> { sub, email, scope }
  refresh: new Map(),      // refresh token -> { sub, scope, revoked }
  sites: [{ siteUrl: SITE_URL, permissionLevel: "siteOwner" }, { siteUrl: "https://other-client.example.test/", permissionLevel: "siteFullUser" }],
  revoked: [],
  apiCalls: 0,
  tokenCalls: 0,
};
function readBody(req) { return new Promise((res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => res(b)); }); }
function send(res, status, body) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
const access = new Map(); // access token -> sub
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, GOOGLE);
  const body = await readBody(req);
  if (url.pathname === "/token") {
    g.tokenCalls++;
    const f = Object.fromEntries(new URLSearchParams(body));
    if (f.client_id !== OAUTH.client_id || f.client_secret !== OAUTH.client_secret) return send(res, 401, { error: "invalid_client" });
    let who;
    if (f.grant_type === "authorization_code") {
      who = g.codes.get(f.code);
      if (!who || f.redirect_uri !== "http://127.0.0.1:3000/api/integrations/gsc/callback") return send(res, 400, { error: "invalid_grant" });
      g.codes.delete(f.code);
      const rt = `1//rt-${randomUUID()}`;
      g.refresh.set(rt, { ...who, revoked: false });
      const at = `ya29.${randomUUID()}`;
      access.set(at, who.sub);
      return send(res, 200, { access_token: at, expires_in: 3599, refresh_token: rt, scope: who.scope, token_type: "Bearer", id_token: "x" });
    }
    if (f.grant_type === "refresh_token") {
      const r = g.refresh.get(f.refresh_token);
      if (!r || r.revoked) return send(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      const at = `ya29.${randomUUID()}`;
      access.set(at, r.sub);
      return send(res, 200, { access_token: at, expires_in: 3599, scope: r.scope });
    }
    return send(res, 400, { error: "unsupported_grant_type" });
  }
  if (url.pathname === "/revoke") { g.revoked.push(Object.fromEntries(new URLSearchParams(body)).token); return send(res, 200, {}); }
  const at = String(req.headers.authorization || "").replace(/^Bearer /, "");
  const sub = access.get(at);
  if (url.pathname === "/userinfo") return sub ? send(res, 200, { sub, email: `${sub}@example.test`, email_verified: true }) : send(res, 401, { error: "invalid_token" });
  if (url.pathname.startsWith("/webmasters/v3")) {
    g.apiCalls++;
    if (!sub) return send(res, 401, { error: { status: "UNAUTHENTICATED" } });
    if (url.pathname === "/webmasters/v3/sites") return send(res, 200, { siteEntry: g.sites });
    const m = /^\/webmasters\/v3\/sites\/([^/]+)\/searchAnalytics\/query$/.exec(url.pathname);
    if (m) {
      const site = decodeURIComponent(m[1]);
      if (site !== SITE_URL) return send(res, 403, { error: { message: "User does not have sufficient permission for site" } });
      const q = JSON.parse(body);
      if (q.dataState !== "final" && q.dataState !== "all") return send(res, 400, {});
      const end = q.endDate > LATEST ? LATEST : q.endDate;
      const all = q.startDate > end ? [] : fakeRows(q.dimensions, q.startDate, end);
      return send(res, 200, { rows: all.slice(q.startRow, q.startRow + q.rowLimit), responseAggregationType: "byProperty" });
    }
  }
  send(res, 404, {});
});

// ---------------------------------------------------------------- helpers
let admin;
let key;
const ids = {};
const users = {};
const clients = new Map();
class OpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
async function op(user, path, body) {
  try { return await clients.get(user).send(`/api/bsa/${path}`, { method: "POST", body, requestKey: null }); } catch (e) { throw new OpError(e.status, e.response?.code, e.response?.message || String(e)); }
}
const rejects = async (p, code) => { await assert.rejects(p, (e) => { assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`); return true; }); };
async function authorize(user, websiteId, { sub = "google-sub-a", scope = `openid email ${READONLY_SCOPE}`, connectionId } = {}) {
  const start = await op(user, "gsc/oauth/start", { websiteId, connectionId });
  const u = new URL(start.url);
  const code = `code-${randomUUID()}`;
  g.codes.set(code, { sub, email: `${sub}@example.test`, scope });
  return { state: u.searchParams.get("state"), code, url: u };
}
async function runWorker(max = 3) {
  const out = [];
  for (let i = 0; i < max; i++) {
    const job = await claimNextJob(admin);
    if (!job) break;
    if (![ids.orgA, ids.orgB].includes(job.organization)) { await admin.collection("gsc_sync_jobs").update(job.id, { status: "queued" }); break; }
    out.push({ job: job.id, ...(await processJob(admin, job, { env: WORKER_ENV, key, oauth: OAUTH, logger: quiet })) });
  }
  return out;
}

before(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  admin = new PocketBase(PB_URL);
  admin.autoCancellation(false);
  await admin.collection("_superusers").authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);
  key = loadKey(process.env);
  const orgA = await admin.collection("organizations").create({ name: `${TAG} A`, slug: `${TAG}-a`, status: "active", created_at: NOW() });
  const orgB = await admin.collection("organizations").create({ name: `${TAG} B`, slug: `${TAG}-b`, status: "active", created_at: NOW() });
  const cA = await admin.collection("clients").create({ organization: orgA.id, business_name: "Tlaloc P6", slug: `${TAG}-ca`, primary_language: "es", primary_location: "Ciudad Juárez", status: "active", created_at: NOW() });
  const cB = await admin.collection("clients").create({ organization: orgB.id, business_name: `${TAG} B`, slug: `${TAG}-cb`, primary_language: "es", status: "active", created_at: NOW() });
  const w = async (org, c, domain) => admin.collection("websites").create({ organization: org, client: c, name: `${TAG} ${domain}`, domain, platform: "nextjs", primary_language: "es", status: "active", created_at: NOW() });
  Object.assign(ids, { orgA: orgA.id, orgB: orgB.id, cA: cA.id, cB: cB.id });
  ids.wA = (await w(orgA.id, cA.id, DOMAIN)).id;
  ids.wA2 = (await w(orgA.id, cA.id, "second.example.test")).id;
  ids.wB = (await w(orgB.id, cB.id, "b.example.test")).id;
  for (const [name, org, role] of [["admin", orgA.id, "admin"], ["editor", orgA.id, "editor"], ["viewer", orgA.id, "viewer"], ["adminB", orgB.id, "admin"]]) {
    const u = await admin.collection("users").create({ email: `${TAG}-${name}@test.local`, password: PASS, passwordConfirm: PASS, name: `${TAG} ${name}`, organization: org, role, status: "active" });
    users[name] = u;
    const pb = new PocketBase(PB_URL);
    pb.autoCancellation(false);
    await pb.collection("users").authWithPassword(u.email, PASS);
    clients.set(name, pb);
  }
  // Phase 3 strategy context (read-only for Phase 6).
  const sv = await admin.collection("strategy_versions").create({ organization: orgA.id, client: cA.id, website: ids.wA, version: 1, generated_at: NOW(), created_at: NOW() });
  await admin.collection("keywords").create({ organization: orgA.id, client: cA.id, website: ids.wA, strategy_version: sv.id, keyword: "instalación paneles solares juárez", normalized_keyword: "instalación paneles solares juárez", language: "es", intent: "commercial", source: "manual", status: "approved", priority: "high", recommended_target_page: "/servicios/instalacion", evidence: {}, created_at: NOW() });
  ids.sv = sv.id;
});

after(async () => {
  server.close();
  if (!admin) return;
  for (const col of ["notifications", "analytics_opportunities", "gsc_query_labels", "gsc_query_page_daily", "gsc_query_daily", "gsc_page_daily", "gsc_site_daily", "gsc_data_quality_flags", "gsc_sync_jobs", "gsc_properties", "gsc_oauth_states", "gsc_connections", "content_opportunities", "activity_logs"]) {
    for (const org of [ids.orgA, ids.orgB]) {
      if (!org) continue;
      const recs = await admin.collection(col).getFullList({ filter: `organization = "${org}"`, fields: "id" }).catch(() => []);
      for (const r of recs) await admin.collection(col).delete(r.id).catch(() => {});
    }
  }
  for (const u of Object.values(users)) await admin.collection("users").delete(u.id).catch(() => {});
  for (const col of ["keywords", "strategy_versions", "websites", "clients"]) for (const org of [ids.orgA, ids.orgB]) {
    const recs = await admin.collection(col).getFullList({ filter: `organization = "${org}"`, fields: "id" }).catch(() => []);
    for (const r of recs) await admin.collection(col).delete(r.id).catch(() => {});
  }
  for (const org of [ids.orgA, ids.orgB]) if (org) await admin.collection("organizations").delete(org).catch(() => {});
});

// ================================================================ OAuth
test("OAuth start: readonly scope only (+openid/email), offline access, state bound to user", async () => {
  await rejects(op("editor", "gsc/oauth/start", { websiteId: ids.wA }), "FORBIDDEN");
  await rejects(op("viewer", "gsc/oauth/start", { websiteId: ids.wA }), "FORBIDDEN");
  await rejects(op("adminB", "gsc/oauth/start", { websiteId: ids.wA }), "NOT_FOUND");
  const s = await op("admin", "gsc/oauth/start", { websiteId: ids.wA });
  const u = new URL(s.url);
  assert.equal(u.origin + u.pathname, `${GOOGLE}/auth`);
  assert.deepEqual(u.searchParams.get("scope").split(" ").sort(), ["email", "openid", READONLY_SCOPE].sort());
  assert.ok(!u.searchParams.get("scope").split(" ").includes("https://www.googleapis.com/auth/webmasters"));
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("redirect_uri"), "http://127.0.0.1:3000/api/integrations/gsc/callback");
  assert.ok(u.searchParams.get("state").length >= 40);
  // The raw state is never stored (only its hash) and the table is not readable by users.
  const states = await admin.collection("gsc_oauth_states").getFullList({ filter: `user = "${users.admin.id}"` });
  assert.ok(states.length >= 1);
  assert.ok(states.every((r) => r.state_hash === undefined || r.state_hash !== u.searchParams.get("state")));
  await assert.rejects(clients.get("admin").collection("gsc_oauth_states").getFullList(), (e) => [403, 404].includes(e.status) || true);
  const visible = await clients.get("admin").collection("gsc_oauth_states").getFullList().catch(() => []);
  assert.equal(visible.length, 0);
});

test("OAuth callback: wrong user / cross-tenant / expired / replay are rejected", async () => {
  const a = await authorize("admin", ids.wA);
  await rejects(op("adminB", "gsc/oauth/complete", { state: a.state, code: a.code }), "STATE_MISMATCH");
  // The failed attempt consumed nothing for the legit user? It must not: mismatch fails before consumption.
  await rejects(op("editor", "gsc/oauth/complete", { state: a.state, code: a.code }), "FORBIDDEN");
  await rejects(op("admin", "gsc/oauth/complete", { state: "forged-state-value", code: a.code }), "STATE_INVALID");
  // Expired state.
  const b = await authorize("admin", ids.wA);
  const rec = (await admin.collection("gsc_oauth_states").getFullList({ filter: `user = "${users.admin.id}" && used_at = ""`, sort: "-created_at" }))[0];
  await admin.collection("gsc_oauth_states").update(rec.id, { expires_at: new Date(Date.now() - 1000).toISOString().replace("T", " ") });
  await rejects(op("admin", "gsc/oauth/complete", { state: b.state, code: b.code }), "STATE_EXPIRED");
  // Valid flow for the first state, then replay.
  const ok = await op("admin", "gsc/oauth/complete", { state: a.state, code: a.code });
  assert.equal(ok.googleAccountEmail, "google-sub-a@example.test");
  assert.equal(ok.properties, 2);
  ids.connA = ok.connectionId;
  await rejects(op("admin", "gsc/oauth/complete", { state: a.state, code: a.code }), "STATE_REPLAYED");
});

test("OAuth: missing readonly scope is refused", async () => {
  const a = await authorize("admin", ids.wA2, { sub: "google-sub-noscope", scope: "openid email" });
  await rejects(op("admin", "gsc/oauth/complete", { state: a.state, code: a.code }), "SCOPE_MISSING");
  const conns = await admin.collection("gsc_connections").getFullList({ filter: `google_sub = "google-sub-noscope"` });
  assert.equal(conns.length, 0);
});

test("refresh token encrypted at rest and never returned to users", async () => {
  const raw = await admin.collection("gsc_connections").getOne(ids.connA);
  assert.ok(raw.encrypted_refresh_token && !raw.encrypted_refresh_token.startsWith("1//"));
  const plain = decrypt(raw.encrypted_refresh_token, key);
  assert.ok(plain.startsWith("1//rt-"));
  assert.ok(g.refresh.has(plain));
  const asUser = await clients.get("admin").collection("gsc_connections").getOne(ids.connA);
  assert.equal(asUser.encrypted_refresh_token, undefined);
  assert.equal(asUser.google_sub, undefined);
  const info = await op("admin", "gsc/connection", { websiteId: ids.wA });
  const text = JSON.stringify(info);
  assert.doesNotMatch(text, /1\/\/rt-|ya29\.|encrypted_refresh_token|test-secret/);
  assert.equal(info.connections[0].google_account_email, "google-sub-a@example.test");
  assert.ok(info.connections[0].scopes.includes(READONLY_SCOPE));
  const act = await admin.collection("activity_logs").getFullList({ filter: `organization = "${ids.orgA}" && action = "GSC_CONNECTED"` });
  assert.equal(act.length, 1);
  assert.doesNotMatch(JSON.stringify(act), /1\/\/rt-|ya29\./);
});

test("tenant isolation: org B cannot see or use org A's connection/properties", async () => {
  assert.equal((await clients.get("adminB").collection("gsc_connections").getFullList()).length, 0);
  assert.equal((await clients.get("adminB").collection("gsc_properties").getFullList()).length, 0);
  await rejects(op("adminB", "gsc/properties/refresh", { connectionId: ids.connA }), "NOT_FOUND");
  await rejects(op("adminB", "gsc/disconnect", { connectionId: ids.connA, confirm: true }), "NOT_FOUND");
  const props = await op("admin", "gsc/properties", { websiteId: ids.wA, connectionId: ids.connA });
  ids.propA = props.find((p) => p.site_url === SITE_URL).id;
  ids.propOther = props.find((p) => p.site_url !== SITE_URL).id;
  await rejects(op("adminB", "gsc/property/select", { websiteId: ids.wB, propertyId: ids.propA, confirm: true }), "NOT_FOUND");
  await rejects(op("adminB", "gsc/properties", { websiteId: ids.wA }), "NOT_FOUND");
});

test("direct REST writes are blocked for every Phase 6 collection", async () => {
  const u = clients.get("admin");
  const attempts = [
    ["gsc_connections", { organization: ids.orgA, status: "connected", scopes: [] }],
    ["gsc_properties", { organization: ids.orgA, connection: ids.connA, site_url: "sc-domain:evil.test", property_type: "domain", status: "active" }],
    ["gsc_sync_jobs", { organization: ids.orgA, website: ids.wA, property: ids.propA, status: "queued", sync_type: "manual" }],
    ["gsc_site_daily", { organization: ids.orgA, website: ids.wA, property: ids.propA, date: "2026-09-01", search_type: "web", clicks: 999 }],
    ["analytics_opportunities", { organization: ids.orgA, client: ids.cA, website: ids.wA, type: "new_query", dedupe_key: "x", evidence: {}, priority: "high", status: "accepted", source: "fake" }],
    ["notifications", { organization: ids.orgA, kind: "x", severity: "info", title: "x", dedupe_key: "x" }],
  ];
  for (const [col, data] of attempts) await assert.rejects(u.collection(col).create(data), (e) => [400, 403].includes(e.status), col);
  await assert.rejects(u.collection("gsc_connections").update(ids.connA, { status: "revoked" }), (e) => [403, 404].includes(e.status));
  // PocketBase answers 404 when an update rule rejects the request.
  await assert.rejects(u.collection("websites").update(ids.wA, { analytics_settings: { striking: { min_impressions: 0 } } }), (e) => [400, 403, 404].includes(e.status));
  assert.equal((await admin.collection("websites").getOne(ids.wA)).analytics_settings, null);
});

test("property matching: MATCHED / POSSIBLE MATCH / MISMATCH requires explicit confirmation", async () => {
  const props = await op("admin", "gsc/properties", { websiteId: ids.wA, connectionId: ids.connA });
  assert.equal(props.find((p) => p.id === ids.propA).match_status, "matched");
  assert.equal(props.find((p) => p.id === ids.propOther).match_status, "mismatch");
  // site_url stored exactly as Google returned it.
  assert.ok(props.some((p) => p.site_url === "https://other-client.example.test/"));
  await rejects(op("admin", "gsc/property/select", { websiteId: ids.wA, propertyId: ids.propOther, confirm: true }), "PROPERTY_MISMATCH");
  await rejects(op("admin", "gsc/property/select", { websiteId: ids.wA, propertyId: ids.propA }), "CONFIRMATION_REQUIRED");
  await rejects(op("editor", "gsc/property/select", { websiteId: ids.wA, propertyId: ids.propA, confirm: true }), "FORBIDDEN");
  const r = await op("admin", "gsc/property/select", { websiteId: ids.wA, propertyId: ids.propA, confirm: true });
  assert.equal(r.matchStatus, "matched");
  assert.ok(r.job?.id);
  ids.job1 = r.job.id;
  // Same property cannot be mapped to a second website.
  await rejects(op("admin", "gsc/property/select", { websiteId: ids.wA2, propertyId: ids.propA, confirm: true, confirmDomain: DOMAIN }), "PROPERTY_IN_USE");
});

test("initial sync: 90 finalized days, all four datasets, latest final date, values verbatim", async () => {
  const job = await admin.collection("gsc_sync_jobs").getOne(ids.job1);
  assert.equal(job.sync_type, "initial");
  assert.equal(job.range_label, "90d");
  // A second request while queued is deduplicated.
  const dup = await op("editor", "gsc/sync", { websiteId: ids.wA, range: "28d" });
  assert.equal(dup.job.id, ids.job1);
  assert.equal(dup.job.deduplicated, true);
  const res = await runWorker(1);
  assert.equal(res[0].status, "completed");
  const done = await admin.collection("gsc_sync_jobs").getOne(ids.job1);
  assert.equal(done.start_date, "2026-06-23");
  assert.equal(done.end_date, LATEST);
  assert.equal(done.data_state, "final");
  assert.equal(done.pagination_completed, true);
  assert.equal(done.rows_received, done.rows_stored);
  assert.ok(done.warnings.some((w) => w.code === "ANONYMIZED_QUERIES"));
  for (const k of ["site", "page", "query", "query_page"]) assert.ok(done.datasets[k].rows_returned > 0, k);
  const prop = await admin.collection("gsc_properties").getOne(ids.propA);
  assert.equal(prop.latest_final_date, LATEST);
  assert.equal(prop.source_timezone, "Google Search Console / PT");
  const site = await admin.collection("gsc_site_daily").getFullList({ filter: `website = "${ids.wA}"` });
  assert.equal(site.length, 90);
  const qp = await admin.collection("gsc_query_page_daily").getFirstListItem(`website = "${ids.wA}" && date = "2026-09-01" && query = "instalacion paneles solares juarez"`);
  assert.equal(qp.clicks, 3); assert.equal(qp.impressions, 60); assert.equal(qp.position, 7.5); assert.equal(qp.ctr, 0.05); assert.equal(qp.page, PAGE_A);
  const acts = (await admin.collection("activity_logs").getFullList({ filter: `organization = "${ids.orgA}"` })).map((a) => a.action);
  for (const a of ["GSC_PROPERTY_SELECTED", "GSC_SYNC_STARTED", "GSC_SYNC_COMPLETED"]) assert.ok(acts.includes(a), a);
});

test("idempotent sync: re-syncing the same days never duplicates rows", async () => {
  const count = async (col) => (await admin.collection(col).getList(1, 1, { filter: `website = "${ids.wA}"` })).totalItems;
  const before = { s: await count("gsc_site_daily"), p: await count("gsc_page_daily"), q: await count("gsc_query_daily"), qp: await count("gsc_query_page_daily") };
  await op("editor", "gsc/sync", { websiteId: ids.wA, range: "28d" });
  const r = await runWorker(1);
  assert.equal(r[0].status, "completed");
  assert.deepEqual({ s: await count("gsc_site_daily"), p: await count("gsc_page_daily"), q: await count("gsc_query_daily"), qp: await count("gsc_query_page_daily") }, before);
});

test("sync request validation: role, range limits, backfill admin-only", async () => {
  await rejects(op("viewer", "gsc/sync", { websiteId: ids.wA, range: "28d" }), "FORBIDDEN");
  await rejects(op("adminB", "gsc/sync", { websiteId: ids.wA, range: "28d" }), "NOT_FOUND");
  await rejects(op("editor", "gsc/sync", { websiteId: ids.wA, range: "6m" }), "FORBIDDEN");
  await rejects(op("admin", "gsc/sync", { websiteId: ids.wA, range: "custom", startDate: "2026-09-10", endDate: "2026-09-01" }), "INVALID_RANGE");
  await rejects(op("admin", "gsc/sync", { websiteId: ids.wA, range: "custom", startDate: "2020-01-01", endDate: "2026-09-01" }), "RANGE_TOO_LARGE");
  await rejects(op("admin", "gsc/sync", { websiteId: ids.wA, range: "forever" }), "INVALID_RANGE");
  await rejects(op("admin", "gsc/sync", { websiteId: ids.wA2, range: "28d" }), "NO_PROPERTY");
});

test("analytics summary: server-side totals, comparison, data-through date and source label", async () => {
  const s = await op("viewer", "analytics/summary", { websiteId: ids.wA, range: "28d" });
  assert.equal(s.dataThrough, LATEST);
  assert.equal(s.source, "Google Search Console");
  assert.deepEqual([s.period.start, s.period.end, s.period.prevStart, s.period.prevEnd], ["2026-08-24", LATEST, "2026-07-27", "2026-08-23"]);
  // current: (3+0+2+1) clicks/day, (60+12+4+10) impr/day
  assert.equal(s.totals.clicks, 28 * 6);
  assert.equal(s.totals.impressions, 28 * 86);
  assert.equal(s.totals.ctr, (28 * 6) / (28 * 86));
  assert.equal(s.previousTotals.clicks, 28 * 4);
  assert.equal(s.comparison.clicks.abs, 28 * 2);
  assert.equal(s.comparison.clicks.pct, 0.5);
  assert.equal(s.daily.length, 28);
  assert.equal(s.coverage.currentDays, 28);
  await rejects(op("adminB", "analytics/summary", { websiteId: ids.wA }), "NOT_FOUND");
});

test("queries & pages: pagination, landing page, Phase 3 mapping, brand classification", async () => {
  const q = await op("viewer", "analytics/queries", { websiteId: ids.wA, range: "28d", perPage: 10 });
  assert.equal(q.total, 3);
  const inst = q.rows.find((r) => r.query === "instalacion paneles solares juarez");
  assert.equal(inst.mapping, "known_keyword");
  assert.equal(inst.landing_page, PAGE_A);
  assert.equal(inst.clicks, 84);
  assert.equal(inst.previous.clicks, 28);
  assert.equal(q.rows.find((r) => r.query === "paneles solares para negocio juarez").mapping, "new_query");
  assert.equal(q.rows.find((r) => r.query === "tlaloc p6").brand, "branded");
  const branded = await op("viewer", "analytics/queries", { websiteId: ids.wA, range: "28d", brand: "branded" });
  assert.deepEqual(branded.rows.map((r) => r.query), ["tlaloc p6"]);
  const byPage = await op("viewer", "analytics/queries", { websiteId: ids.wA, range: "28d", pageUrl: PAGE_A });
  assert.deepEqual(byPage.rows.map((r) => r.query), ["instalacion paneles solares juarez"]);
  const p = await op("viewer", "analytics/pages", { websiteId: ids.wA, range: "28d" });
  assert.equal(p.total, 2);
  assert.deepEqual(p.rows.find((r) => r.page === PAGE_A).mapping.strategy_keywords, ["instalación paneles solares juárez"]);
  const d = await op("viewer", "analytics/query", { websiteId: ids.wA, range: "28d", query: "instalacion paneles solares juarez" });
  assert.equal(d.landingPages[0].page, PAGE_A);
  assert.equal(d.daily.length, 28);
  await rejects(op("adminB", "analytics/queries", { websiteId: ids.wA }), "NOT_FOUND");
  await rejects(op("adminB", "analytics/pages", { websiteId: ids.wA }), "NOT_FOUND");
});

test("opportunities: real detections with evidence, dedup across syncs, human decisions persist", async () => {
  const list = await clients.get("viewer").collection("analytics_opportunities").getFullList({ filter: `website = "${ids.wA}"` });
  const types = new Set(list.map((o) => o.type));
  assert.ok(types.has("new_query"), [...types].join());
  assert.ok(types.has("striking_distance"));
  for (const o of list) { assert.equal(o.source, "google_search_console"); assert.ok(o.reason && o.evidence.current_period); }
  const sd = list.find((o) => o.type === "striking_distance" && o.query === "instalacion paneles solares juarez");
  assert.match(sd.reason, /Query received 1,680 impressions at average position 7\.5/);
  // Viewer cannot decide; org B cannot see.
  await rejects(op("viewer", "analytics/opportunity/decide", { opportunityId: sd.id, action: "accept" }), "FORBIDDEN");
  await rejects(op("adminB", "analytics/opportunity/decide", { opportunityId: sd.id, action: "ignore" }), "NOT_FOUND");
  assert.equal((await clients.get("adminB").collection("analytics_opportunities").getFullList()).length, 0);
  const nq = list.find((o) => o.type === "new_query");
  await op("editor", "analytics/opportunity/decide", { opportunityId: nq.id, action: "ignore", note: "brand noise" });
  // Accept + explicit Phase 3 feedback.
  const r = await op("editor", "analytics/opportunity/decide", { opportunityId: sd.id, action: "accept", createContentOpportunity: true });
  assert.ok(r.contentOpportunity);
  const co = await admin.collection("content_opportunities").getOne(r.contentOpportunity);
  assert.equal(co.status, "proposed");
  assert.equal(co.evidence.source, "google_search_console");
  // Another sync: same opportunities updated, not duplicated; decisions kept.
  const before = list.length;
  await op("editor", "gsc/sync", { websiteId: ids.wA, range: "7d" });
  await runWorker(1);
  const after = await admin.collection("analytics_opportunities").getFullList({ filter: `website = "${ids.wA}"` });
  assert.equal(after.length, before);
  assert.equal(after.find((o) => o.id === nq.id).status, "ignored");
  assert.equal(after.find((o) => o.id === sd.id).status, "accepted");
  assert.ok(after.find((o) => o.id === sd.id).detection_count >= 2);
  // No article was created or modified by analytics.
  assert.equal((await admin.collection("articles").getList(1, 1, { filter: `organization = "${ids.orgA}"` })).totalItems, 0);
  const acts = (await admin.collection("activity_logs").getFullList({ filter: `organization = "${ids.orgA}"` })).map((a) => a.action);
  assert.ok(acts.includes("ANALYTICS_OPPORTUNITY_IGNORED") && acts.includes("ANALYTICS_OPPORTUNITY_ACCEPTED"));
});

test("data quality flag excludes a date range from opportunity detection", async () => {
  await rejects(op("editor", "analytics/quality-flag", { websiteId: ids.wA, startDate: "2026-09-01", endDate: "2026-09-05", reason: "x" }), "FORBIDDEN");
  await rejects(op("admin", "analytics/quality-flag", { websiteId: ids.wA, startDate: "2026-09-01", endDate: "2026-09-05", reason: "" }), "REASON_REQUIRED");
  const f = await op("admin", "analytics/quality-flag", { websiteId: ids.wA, startDate: "2026-08-24", endDate: "2026-09-20", reason: "Google reporting gap (test)" });
  assert.ok(f.id);
  const website = await admin.collection("websites").getOne(ids.wA);
  const prop = await admin.collection("gsc_properties").getOne(ids.propA);
  const res = await analyze(admin, { website, property: prop, logger: quiet });
  assert.equal(res.created, 0);
  await op("admin", "analytics/quality-flag", { websiteId: ids.wA, flagId: f.id });
});

test("daily scheduler queues one deduplicated job per property per day", async () => {
  const n1 = await scheduleDaily(admin, { now: new Date("2026-09-24T12:00:00Z"), hourUtc: 10, logger: quiet });
  const n2 = await scheduleDaily(admin, { now: new Date("2026-09-24T12:10:00Z"), hourUtc: 10, logger: quiet });
  assert.ok(n1 >= 1);
  assert.equal(n2, 0);
  const r = await runWorker(3);
  assert.ok(r.every((x) => x.status === "completed"));
  // Already run today → nothing new even after completion.
  assert.equal(await scheduleDaily(admin, { now: new Date("2026-09-24T18:00:00Z"), hourUtc: 10, logger: quiet }), 0);
});

test("revoked refresh token → reauth_required + deduplicated notification, no hammering", async () => {
  for (const r of g.refresh.values()) r.revoked = true;
  const calls = g.tokenCalls;
  await op("editor", "gsc/sync", { websiteId: ids.wA, range: "7d" });
  const r = await runWorker(1);
  assert.equal(r[0].status, "failed");
  assert.ok(g.tokenCalls - calls <= 1);
  const c = await admin.collection("gsc_connections").getOne(ids.connA);
  assert.equal(c.status, "reauth_required");
  await rejects(op("editor", "gsc/sync", { websiteId: ids.wA, range: "7d" }), "CONNECTION_NOT_READY");
  const notes = await admin.collection("notifications").getFullList({ filter: `organization = "${ids.orgA}" && kind = "gsc_reauth"` });
  assert.equal(notes.length, 1);
  const failed = await admin.collection("activity_logs").getFullList({ filter: `organization = "${ids.orgA}" && action = "GSC_SYNC_FAILED"` });
  assert.ok(failed.length >= 1);
  assert.doesNotMatch(JSON.stringify(failed) + JSON.stringify(c), /1\/\/rt-|ya29\./);
});

test("reconnect with the same Google account restores the connection; different account refused", async () => {
  const wrong = await authorize("admin", ids.wA, { sub: "google-sub-other", connectionId: ids.connA });
  await rejects(op("admin", "gsc/oauth/complete", { state: wrong.state, code: wrong.code }), "ACCOUNT_MISMATCH");
  const a = await authorize("admin", ids.wA, { sub: "google-sub-a", connectionId: ids.connA });
  const r = await op("admin", "gsc/oauth/complete", { state: a.state, code: a.code });
  assert.equal(r.reconnected, true);
  assert.equal(r.connectionId, ids.connA);
  assert.equal((await admin.collection("gsc_connections").getOne(ids.connA)).status, "connected");
});

test("multi-account: a second Google account becomes a separate connection in the same org", async () => {
  const b = await authorize("admin", ids.wA2, { sub: "google-sub-b" });
  const r = await op("admin", "gsc/oauth/complete", { state: b.state, code: b.code });
  assert.notEqual(r.connectionId, ids.connA);
  const conns = await clients.get("admin").collection("gsc_connections").getFullList();
  assert.equal(conns.length, 2);
  ids.connB = r.connectionId;
});

test("property access lost: data kept, property marked access_lost, notification", async () => {
  g.sites = g.sites.filter((s) => s.siteUrl !== SITE_URL);
  await op("admin", "gsc/properties/refresh", { connectionId: ids.connA });
  const p = await admin.collection("gsc_properties").getOne(ids.propA);
  assert.equal(p.status, "access_lost");
  assert.equal((await admin.collection("gsc_site_daily").getList(1, 1, { filter: `website = "${ids.wA}"` })).totalItems, 90);
  await rejects(op("editor", "gsc/sync", { websiteId: ids.wA, range: "7d" }), "ACCESS_LOST");
  assert.equal((await admin.collection("notifications").getFullList({ filter: `organization = "${ids.orgA}" && kind = "gsc_access_lost"` })).length, 1);
  g.sites.push({ siteUrl: SITE_URL, permissionLevel: "siteOwner" });
  await op("admin", "gsc/properties/refresh", { connectionId: ids.connA });
  assert.equal((await admin.collection("gsc_properties").getOne(ids.propA)).status, "active");
});

test("disconnect: token revoked + removed locally, future sync disabled, history kept", async () => {
  await rejects(op("editor", "gsc/disconnect", { connectionId: ids.connA, confirm: true }), "FORBIDDEN");
  await rejects(op("admin", "gsc/disconnect", { connectionId: ids.connA }), "CONFIRMATION_REQUIRED");
  const revokedBefore = g.revoked.length;
  const r = await op("admin", "gsc/disconnect", { connectionId: ids.connA, confirm: true });
  assert.equal(r.historicalDataKept, true);
  assert.equal(g.revoked.length, revokedBefore + 1);
  const c = await admin.collection("gsc_connections").getOne(ids.connA);
  assert.equal(c.status, "disconnected");
  assert.equal(c.encrypted_refresh_token, "");
  await rejects(op("editor", "gsc/sync", { websiteId: ids.wA, range: "7d" }), "CONNECTION_NOT_READY");
  assert.equal((await admin.collection("gsc_site_daily").getList(1, 1, { filter: `website = "${ids.wA}"` })).totalItems, 90);
  const s = await op("viewer", "analytics/summary", { websiteId: ids.wA, range: "28d" });
  assert.equal(s.totals.clicks, 28 * 6);
  const acts = (await admin.collection("activity_logs").getFullList({ filter: `organization = "${ids.orgA}"` })).map((a) => a.action);
  assert.ok(acts.includes("GSC_DISCONNECTED") && acts.includes("GSC_RECONNECTED"));
});

test("organization and client overviews aggregate correctly and only for own tenant", async () => {
  const o = await op("viewer", "analytics/organization", { range: "28d" });
  assert.equal(o.clicks.current, 28 * 6);
  assert.equal(o.websitesConnected, 1);
  const ob = await op("adminB", "analytics/organization", { range: "28d" });
  assert.equal(ob.clicks.current, 0);
  assert.equal(ob.websitesConnected, 0);
  const c = await op("viewer", "analytics/client", { clientId: ids.cA, range: "28d" });
  assert.equal(c.aggregate.ctr, c.aggregate.clicks / c.aggregate.impressions);
  assert.equal(c.sites.find((s) => s.website.id === ids.wA2).connected, false);
  await rejects(op("adminB", "analytics/client", { clientId: ids.cA }), "NOT_FOUND");
});

test("internal endpoints require the superuser", async () => {
  for (const path of ["internal/gsc/upsert", "internal/gsc/labels", "internal/gsc/aggregate"]) {
    await assert.rejects(clients.get("admin").send(`/api/bsa/${path}`, { method: "POST", body: { table: "gsc_site_daily", website: ids.wA, property: ids.propA, rows: [] }, requestKey: null }), (e) => [401, 403].includes(e.status), path);
  }
});
