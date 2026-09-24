#!/usr/bin/env node
/**
 * Phase 5 integration tests — publishing engine end to end against a LOCAL
 * PocketBase (hooks loaded) and a loopback fake target site that implements
 * the PocketBase-CMS page reader, the Next.js API publisher contract, a
 * signed webhook receiver and a minimal WordPress REST API.
 *
 * Human actions use regular user tokens through /api/bsa/publishing/*;
 * the superuser is used ONLY for fixtures, the worker and assertions.
 *
 * Requires PocketBase started with:
 *   PUBLISHING_KEY_FILE=<32-char key file> BSA_PUBLISH_PRIVATE_ALLOWLIST=127.0.0.1:3399
 *   --hooksDir=<repo>/pb_hooks
 * and the same PUBLISHING_KEY_FILE in this process env.
 * LOCAL ONLY (guarded). Uniquely tagged fixtures, deleted afterwards.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import PocketBase from "pocketbase";
import { randomUUID } from "node:crypto";
import { assertLocalTarget } from "./lib/local-only.mjs";
import { claimNextJob, processJob } from "../publisher-worker/src/engine.js";
import { loadKey } from "../publisher-worker/src/secrets.js";
import { verify as verifySig, memoryNonceStore, sign, HEADERS } from "../publisher-worker/src/signing.js";
import { snapshotHash } from "../publisher-worker/src/content.js";

const PB_URL = process.env.PB_URL || "http://127.0.0.1:8097";
assertLocalTarget(PB_URL, "test-phase5");
const ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) throw new Error("PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD required");
const PORT = 3399;
const SITE = `http://127.0.0.1:${PORT}`;
const PASS = "Phase5Test!2026";
const TAG = `p5-${randomUUID().slice(0, 8)}`;
const NOW = () => new Date().toISOString();
const WORKER_ENV = { ...process.env, BSA_PUBLISH_PRIVATE_ALLOWLIST: `127.0.0.1:${PORT}`, PB_PUBLIC_READ_URL: PB_URL };
const quiet = { log() {}, warn() {}, error() {} };
const PRIVATE_TEXT = "INTERNAL-RESEARCH-NOTE-XYZ";

let admin;
let key;
const ids = {};
const users = {};
const clients = new Map();

// ---------------------------------------------------------------- fake target site
const site = {
  secrets: {},          // websiteId -> secret (target side copy)
  store: new Map(),     // `${websiteId}:${slug}` -> article (next/webhook/wp modes)
  hidePages: false,     // simulate "API 200 but page missing"
  failPublish: 0,       // respond 503 N times
  nonces: memoryNonceStore(),
  requests: 0,
  wp: { posts: new Map(), seq: 100, user: "wpuser" },
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const page = (a) => `<!doctype html><html><head><title>${esc(a.seo_title || a.title)}</title><meta name="bunker-content-revision" content="${esc(a.revision || "")}"><meta name="description" content="${esc(a.meta_description || "")}"></head><body><h1>${esc(a.title)}</h1></body></html>`;
async function pbPublic(websiteId, slug) {
  const qs = new URLSearchParams({ website: websiteId });
  if (slug) qs.set("filter", `slug = "${slug}"`);
  const r = await fetch(`${PB_URL}/api/collections/published_content/records?${qs}`);
  return (await r.json()).items || [];
}
function readBody(req) { return new Promise((res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => res(b)); }); }
function send(res, status, body, type = "application/json") { res.writeHead(status, { "content-type": type }); res.end(typeof body === "string" ? body : JSON.stringify(body)); }
function sitemap(urls) { return `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${esc(u)}</loc></url>`).join("")}</urlset>`; }

const server = http.createServer(async (req, res) => {
  site.requests++;
  const url = new URL(req.url, SITE);
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    // PocketBase CMS site: /cms/<websiteId>/blog[/slug], /cms/<websiteId>/sitemap.xml
    if (parts[0] === "cms") {
      const wid = parts[1];
      if (parts[2] === "sitemap.xml") return send(res, 200, sitemap((await pbPublic(wid)).map((a) => `${SITE}/cms/${wid}/blog/${a.slug}`)), "application/xml");
      if (parts[2] === "blog" && !parts[3]) return send(res, 200, "<html>blog</html>", "text/html");
      if (parts[2] === "blog" && parts[3]) {
        const a = site.hidePages ? null : (await pbPublic(wid, parts[3]))[0];
        return a ? send(res, 200, page(a), "text/html") : send(res, 404, "not found", "text/html");
      }
      if (parts[2] === "revalidate" && req.method === "POST") {
        const body = await readBody(req);
        const v = await verifySig({ secrets: [site.secrets[wid]], body, headers: req.headers, nonceStore: site.nonces });
        return v.ok ? send(res, 200, { ok: true }) : send(res, 401, { ok: false, code: v.code });
      }
    }
    // Next.js API / webhook site: /next/<websiteId>/...
    if (parts[0] === "next" || parts[0] === "hook") {
      const wid = parts[1];
      if (parts[2] === "api" && req.method === "POST") {
        const body = await readBody(req);
        if (req.headers[HEADERS.website] !== wid) return send(res, 403, { ok: false, code: "WRONG_WEBSITE" });
        const v = await verifySig({ secrets: [site.secrets[wid]], body, headers: req.headers, nonceStore: site.nonces });
        if (!v.ok) return send(res, 401, { ok: false, code: v.code });
        if (site.failPublish > 0) { site.failPublish--; return send(res, 503, { ok: false }); }
        const j = JSON.parse(body);
        if (j.website_id !== wid) return send(res, 403, { ok: false, code: "WRONG_WEBSITE" });
        if (j.operation === "ping") return send(res, 200, { ok: true, website_id: wid });
        if (j.operation === "unpublish") {
          for (const [k, a] of site.store) if (k.startsWith(`${wid}:`) && a.remote_id === j.remote_id) a.status = "unpublished";
          return send(res, 200, { ok: true });
        }
        const a = j.article;
        const k = `${wid}:${a.slug}`;
        const prev = site.store.get(k);
        if (prev && prev.article_id !== a.article_id) return send(res, 409, { ok: false, code: "SLUG_CONFLICT" });
        const remote = prev?.remote_id || `r-${randomUUID().slice(0, 8)}`;
        site.store.set(k, { ...a, remote_id: remote, status: "published" });
        return parts[0] === "hook" ? send(res, 200, { received: true }) : send(res, 200, { ok: true, remote_id: remote, public_url: `${SITE}/${parts[0]}/${wid}/blog/${a.slug}` });
      }
      if (parts[2] === "blog" && parts[3]) {
        const a = site.store.get(`${wid}:${parts[3]}`);
        return a && a.status === "published" && !site.hidePages ? send(res, 200, page(a), "text/html") : send(res, 404, "nf", "text/html");
      }
      if (parts[2] === "blog") return send(res, 200, "<html>blog</html>", "text/html");
      if (parts[2] === "sitemap.xml") return send(res, 200, sitemap([...site.store.entries()].filter(([k, a]) => k.startsWith(`${wid}:`) && a.status === "published").map(([, a]) => `${SITE}/${parts[0]}/${wid}/blog/${a.slug}`)), "application/xml");
    }
    // WordPress: /wp/<websiteId>/wp-json/wp/v2/...
    if (parts[0] === "wp") {
      const wid = parts[1];
      const auth = req.headers.authorization || "";
      const okAuth = auth === "Basic " + Buffer.from(`${site.wp.user}:${site.secrets[wid]}`).toString("base64");
      if (parts[2] === "wp-json") {
        if (!okAuth) return send(res, 401, { code: "rest_not_logged_in" });
        const rest = "/" + parts.slice(3).join("/");
        if (rest === "/wp/v2/users/me") return send(res, 200, { id: 7 });
        if (rest === "/wp/v2/posts" && req.method === "GET") return send(res, 200, [...site.wp.posts.values()].filter((p) => p.slug === url.searchParams.get("slug")));
        if (rest === "/wp/v2/posts" && req.method === "POST") {
          const b = JSON.parse(await readBody(req));
          const id = ++site.wp.seq;
          const p = { id, ...b, link: `${SITE}/wp/${wid}/blog/${b.slug}` };
          site.wp.posts.set(id, p);
          return send(res, 201, p);
        }
        const m = /^\/wp\/v2\/posts\/(\d+)$/.exec(rest);
        if (m) {
          const p = site.wp.posts.get(Number(m[1]));
          if (!p) return send(res, 404, {});
          if (req.method === "POST") Object.assign(p, JSON.parse(await readBody(req)));
          return send(res, 200, p);
        }
      }
      if (parts[2] === "blog" && parts[3]) {
        const p = [...site.wp.posts.values()].find((x) => x.slug === parts[3] && x.status === "publish");
        return p ? send(res, 200, `<html><h1>${esc(p.title)}</h1></html>`, "text/html") : send(res, 404, "nf", "text/html");
      }
    }
    send(res, 404, "nf", "text/plain");
  } catch (e) {
    send(res, 500, { error: String(e.message) });
  }
});

// ---------------------------------------------------------------- helpers
class OpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
async function op(user, path, body) {
  try {
    return await clients.get(user).send(`/api/bsa/publishing/${path}`, { method: "POST", body, requestKey: null });
  } catch (e) {
    throw new OpError(e.status, e.response?.code, e.response?.message || String(e));
  }
}
async function contentOp(user, path, body) {
  try { return await clients.get(user).send(`/api/bsa/content/${path}`, { method: "POST", body, requestKey: null }); } catch (e) { throw new OpError(e.status, e.response?.code, e.response?.message || String(e)); }
}
const rejects = async (p, code) => { await assert.rejects(p, (e) => { assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`); return true; }); };

async function runWorker(max = 5) {
  const results = [];
  for (let i = 0; i < max; i++) {
    const job = await claimNextJob(admin, new Date(), `organization = "${ids.orgA}" || organization = "${ids.orgB}"`);
    if (!job) break;
    results.push({ job: job.id, ...(await processJob(admin, job, { env: WORKER_ENV, key, logger: quiet })) });
  }
  return results;
}

async function mkArticle(websiteId, clientId, orgId, slug, extra = {}) {
  const base = { organization: orgId, client: clientId, website: websiteId, content_type: "blog_article", title: `Paneles solares ${slug}`, slug, excerpt: "Resumen", seo_title: `SEO ${slug}`, meta_description: "Descripción aprobada", content: `# Paneles solares ${slug}\n\nContenido público de prueba.\n\n<script>alert(1)</script>`, content_format: "markdown", status: "awaiting_approval", language: "es", qa_status: "PASS", fact_check_status: "passed", flags: [], high_risk: false, current_version: 1, research_notes: PRIVATE_TEXT, brief: { note: PRIVATE_TEXT }, structured_data: { "@type": "BlogPosting", headline: `</script><script>alert(1)</script>` }, created_at: NOW(), updated_at: NOW(), ...extra };
  delete base.research_notes;
  const a = await admin.collection("articles").create(base);
  await admin.collection("article_versions").create({ organization: orgId, client: clientId, website: websiteId, article: a.id, version: 1, title: a.title, content: a.content, seo_title: a.seo_title, meta_description: a.meta_description, excerpt: a.excerpt, slug: a.slug, change_type: "ai_generation", created_at: NOW() });
  return a;
}

async function configure(user, websiteId, type, pathPrefix, extra = {}) {
  await op(user, "config", {
    websiteId, publisherType: type, publishingMode: "manual", environment: "staging", enabled: true,
    allowedDomains: ["127.0.0.1"], baseUrl: `${SITE}/${pathPrefix}/${websiteId}`, blogPath: "/blog",
    apiEndpoint: type === "wordpress" ? `${SITE}/wp/${websiteId}/wp-json` : type === "pocketbase_cms" ? "" : `${SITE}/${pathPrefix}/${websiteId}/api`,
    revalidateUrl: type === "pocketbase_cms" ? `${SITE}/cms/${websiteId}/revalidate` : "",
    sitemapUrl: type === "wordpress" ? "" : `${SITE}/${pathPrefix}/${websiteId}/sitemap.xml`, verifySitemap: type !== "wordpress",
    username: type === "wordpress" ? site.wp.user : "", ...extra,
  });
  const s = await op(user, "secret", { websiteId, generate: true });
  site.secrets[websiteId] = s.secret;
  await op(user, "test", { websiteId });
  await runWorker(1);
  return admin.collection("websites").getOne(websiteId);
}

async function approve(user, articleId) {
  await contentOp(user, "approve", { articleId });
  return admin.collection("articles").getOne(articleId);
}

// ---------------------------------------------------------------- fixtures
before(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  admin = new PocketBase(PB_URL);
  admin.autoCancellation(false);
  await admin.collection("_superusers").authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);
  key = loadKey(process.env);
  const orgA = await admin.collection("organizations").create({ name: `${TAG} A`, slug: `${TAG}-a`, status: "active", created_at: NOW() });
  const orgB = await admin.collection("organizations").create({ name: `${TAG} B`, slug: `${TAG}-b`, status: "active", created_at: NOW() });
  const cA = await admin.collection("clients").create({ organization: orgA.id, business_name: `${TAG} Solar A`, slug: `${TAG}-ca`, primary_language: "es", status: "active", created_at: NOW() });
  const cA2 = await admin.collection("clients").create({ organization: orgA.id, business_name: `${TAG} Other A2`, slug: `${TAG}-ca2`, primary_language: "es", status: "active", created_at: NOW() });
  const cB = await admin.collection("clients").create({ organization: orgB.id, business_name: `${TAG} Solar B`, slug: `${TAG}-cb`, primary_language: "es", status: "active", created_at: NOW() });
  const w = async (org, c, n) => admin.collection("websites").create({ organization: org, client: c, name: `${TAG} ${n}`, domain: `${n}.example.test`, platform: "nextjs", primary_language: "es", status: "active", created_at: NOW() });
  Object.assign(ids, { orgA: orgA.id, orgB: orgB.id, cA: cA.id, cA2: cA2.id, cB: cB.id });
  ids.wCms = (await w(orgA.id, cA.id, "cms")).id;
  ids.wNext = (await w(orgA.id, cA.id, "next")).id;
  ids.wHook = (await w(orgA.id, cA.id, "hook")).id;
  ids.wWp = (await w(orgA.id, cA.id, "wp")).id;
  ids.wA2 = (await w(orgA.id, cA2.id, "a2")).id;
  ids.wB = (await w(orgB.id, cB.id, "b")).id;
  for (const [name, org, role] of [["admin", orgA.id, "admin"], ["editor", orgA.id, "editor"], ["viewer", orgA.id, "viewer"], ["adminB", orgB.id, "admin"]]) {
    const u = await admin.collection("users").create({ email: `${TAG}-${name}@test.local`, password: PASS, passwordConfirm: PASS, name: `${TAG} ${name}`, organization: org, role, status: "active" });
    users[name] = u;
    const pb = new PocketBase(PB_URL);
    pb.autoCancellation(false);
    await pb.collection("users").authWithPassword(u.email, PASS);
    clients.set(name, pb);
  }
});

after(async () => {
  server.close();
  if (!admin) return;
  const cols = ["publication_events", "published_content", "publish_jobs", "article_publications", "integrations", "content_taxonomies", "article_versions", "articles", "activity_logs"];
  for (const org of [ids.orgA, ids.orgB].filter(Boolean)) {
    for (const col of cols) {
      const rows = await admin.collection(col).getFullList({ filter: `organization = "${org}"`, fields: "id" }).catch(() => []);
      for (const r of rows) await admin.collection(col).delete(r.id).catch(() => {});
    }
    for (const col of ["users", "websites", "clients"]) {
      const rows = await admin.collection(col).getFullList({ filter: `organization = "${org}"`, fields: "id" }).catch(() => []);
      for (const r of rows) await admin.collection(col).delete(r.id).catch(() => {});
    }
    await admin.collection("organizations").delete(org).catch(() => {});
  }
});

// ---------------------------------------------------------------- tests
test("configuration: admin-only, SSRF/private + domain allowlist, no autopilot", async () => {
  const base = { websiteId: ids.wCms, publisherType: "pocketbase_cms", enabled: true, allowedDomains: ["127.0.0.1"], baseUrl: `${SITE}/cms/${ids.wCms}` };
  await rejects(op("editor", "config", base), "FORBIDDEN");
  await rejects(op("viewer", "config", base), "FORBIDDEN");
  await rejects(op("admin", "config", { ...base, publishingMode: "autopilot_future" }), "INVALID");
  await rejects(op("admin", "config", { ...base, allowedDomains: ["10.0.0.5"], baseUrl: "https://10.0.0.5/x" }), "SSRF_BLOCKED");
  await rejects(op("admin", "config", { ...base, allowedDomains: ["169.254.169.254"], baseUrl: "https://169.254.169.254/" }), "SSRF_BLOCKED");
  await rejects(op("admin", "config", { ...base, allowedDomains: ["localhost"], baseUrl: "https://localhost/" }), "SSRF_BLOCKED");
  await rejects(op("admin", "config", { ...base, allowedDomains: ["site.example.com"], baseUrl: "https://evil.example.com/" }), "DOMAIN_NOT_ALLOWED");
  await rejects(op("admin", "config", { ...base, publisherType: "webhook", apiEndpoint: "https://evil.example.com/hook", allowedDomains: ["127.0.0.1"] }), "DOMAIN_NOT_ALLOWED");
  await rejects(op("adminB", "config", base), "NOT_FOUND");
  // direct REST writes of publishing fields are refused
  await assert.rejects(clients.get("admin").collection("websites").update(ids.wCms, { publishing_enabled: true, base_url: "https://evil.example.com" }));
  const w = await admin.collection("websites").getOne(ids.wCms);
  assert.equal(w.publishing_enabled, false, "publishing disabled until configured");
});

test("connection test: connected; wrong secret → unauthorized; secret never returned", async () => {
  const w = await configure("admin", ids.wCms, "pocketbase_cms", "cms");
  assert.equal(w.connection_status, "connected", w.last_connection_error);
  const integ = await clients.get("admin").collection("integrations").getFirstListItem(`website = "${ids.wCms}"`);
  assert.equal(integ.secret_encrypted, undefined);
  assert.equal(integ.previous_secret_encrypted, undefined);
  assert.equal(integ.secret_last4.length, 4);
  const raw = JSON.stringify(await clients.get("admin").collection("integrations").getFullList());
  assert.ok(!raw.includes(site.secrets[ids.wCms]), "secret not in API output");
  const logs = JSON.stringify(await admin.collection("activity_logs").getFullList({ filter: `organization = "${ids.orgA}"` }));
  assert.ok(!logs.includes(site.secrets[ids.wCms]), "secret not in activity logs");
  // Next.js target with a secret the target does not know → unauthorized
  await configure("admin", ids.wNext, "nextjs_api", "next");
  const good = site.secrets[ids.wNext];
  site.secrets[ids.wNext] = "target-has-a-different-secret-000";
  await op("admin", "test", { websiteId: ids.wNext });
  await runWorker(1);
  assert.equal((await admin.collection("websites").getOne(ids.wNext)).connection_status, "unauthorized");
  site.secrets[ids.wNext] = good;
  await op("admin", "test", { websiteId: ids.wNext });
  const before = site.store.size;
  await runWorker(1);
  assert.equal((await admin.collection("websites").getOne(ids.wNext)).connection_status, "connected");
  assert.equal(site.store.size, before, "connection test publishes nothing");
});

test("approved-only publishing, confirmation, tenant isolation, high risk", async () => {
  const a = await mkArticle(ids.wCms, ids.cA, ids.orgA, "solo-aprobado");
  ids.a1 = a.id;
  await rejects(op("admin", "publish", { articleId: a.id, confirm: true }), "NOT_PUBLISHABLE");
  const approved = await approve("editor", a.id);
  assert.equal(approved.status, "approved");
  assert.equal(approved.approved_version, 1);
  assert.equal(approved.approved_hash, snapshotHash(approved.approved_snapshot));
  await rejects(op("admin", "publish", { articleId: a.id }), "CONFIRMATION_REQUIRED");
  await rejects(op("viewer", "publish", { articleId: a.id, confirm: true }), "FORBIDDEN");
  await rejects(op("adminB", "publish", { articleId: a.id, confirm: true }), "NOT_FOUND");
  await rejects(op("adminB", "preview", { articleId: a.id }), "NOT_FOUND");
  await rejects(op("admin", "publish", { articleId: a.id, websiteId: ids.wNext, confirm: true }), "WEBSITE_MISMATCH");
  await rejects(op("admin", "publish", { articleId: a.id, websiteId: ids.wB, confirm: true }), "WEBSITE_MISMATCH");
  // users cannot create jobs / public rows / logs directly
  await assert.rejects(clients.get("admin").collection("publish_jobs").create({ organization: ids.orgA, client: ids.cA, website: ids.wCms, article: a.id, operation: "publish", status: "queued", idempotency_key: "forged" }));
  await assert.rejects(clients.get("admin").collection("published_content").create({ organization: ids.orgA, client: ids.cA, website: ids.wCms, status: "published", slug: "x" }));
  await assert.rejects(clients.get("admin").collection("activity_logs").create({ organization: ids.orgA, action: "ARTICLE_PUBLISHED" }));
  await assert.rejects(clients.get("admin").collection("articles").update(a.id, { status: "published" }));
  // cross-client inside same org: article of client A2 cannot target website of client A
  const b = await mkArticle(ids.wA2, ids.cA2, ids.orgA, "cliente-dos");
  await rejects(op("admin", "publish", { articleId: b.id, websiteId: ids.wCms, confirm: true }), "WEBSITE_MISMATCH");
  // high risk needs explicit acknowledgement at publication
  const hr = await mkArticle(ids.wCms, ids.cA, ids.orgA, "alto-riesgo", { high_risk: true });
  await contentOp("editor", "approve", { articleId: hr.id, acknowledgeHighRisk: true });
  await rejects(op("admin", "publish", { articleId: hr.id, confirm: true }), "HIGH_RISK_REVIEW_REQUIRED");
  const p = await op("admin", "preview", { articleId: a.id });
  assert.equal(p.operation, "publish");
  assert.equal(p.url_preview, `${SITE}/cms/${ids.wCms}/blog/solo-aprobado`);
  assert.equal(p.blockers.length, 0, p.blockers.join(" | "));
  assert.equal(p.version, 1);
});

test("public content is not visible before publish (404)", async () => {
  assert.equal((await pbPublic(ids.wCms, "solo-aprobado")).length, 0);
  assert.equal((await fetch(`${SITE}/cms/${ids.wCms}/blog/solo-aprobado`)).status, 404);
});

test("double publish is idempotent; worker publishes and verifies (PocketBase CMS)", async () => {
  const [r1, r2] = await Promise.all([op("admin", "publish", { articleId: ids.a1, confirm: true }), op("admin", "publish", { articleId: ids.a1, confirm: true }).catch((e) => e)]);
  const r3 = await op("admin", "publish", { articleId: ids.a1, confirm: true });
  assert.equal(r3.id, r1.id);
  assert.equal(r3.created, false);
  if (!(r2 instanceof Error)) assert.equal(r2.id, r1.id);
  const jobs = await admin.collection("publish_jobs").getFullList({ filter: `article = "${ids.a1}"` });
  assert.equal(jobs.length, 1, "exactly one job");
  assert.equal((await admin.collection("articles").getOne(ids.a1)).status, "publish_queued");
  const out = await runWorker(2);
  assert.equal(out[0].status, "published", JSON.stringify(out));
  const art = await admin.collection("articles").getOne(ids.a1);
  assert.equal(art.status, "published");
  assert.ok(art.published_at);
  assert.equal(art.approved_by, users.editor.id, "approval preserved");
  const pubs = await admin.collection("article_publications").getFullList({ filter: `article = "${ids.a1}"` });
  assert.equal(pubs.length, 1);
  assert.equal(pubs[0].public_url, `${SITE}/cms/${ids.wCms}/blog/solo-aprobado`);
  assert.equal(pubs[0].status, "published");
  assert.ok(pubs[0].last_verified_at);
  ids.pub1 = pubs[0].id;
  assert.equal((await fetch(pubs[0].public_url)).status, 200);
  const acts = (await admin.collection("activity_logs").getFullList({ filter: `entity_id = "${ids.a1}"` })).map((l) => l.action);
  for (const x of ["ARTICLE_APPROVED", "PUBLISH_REQUESTED", "ARTICLE_PUBLISHED"]) assert.ok(acts.includes(x), x);
  const ev = await admin.collection("publication_events").getFullList({ filter: `article = "${ids.a1}"` });
  assert.equal(ev.filter((e) => e.operation === "publish" && e.status === "success").length, 1);
});

test("public API: published only, website-scoped, no internal fields, drafts 404", async () => {
  const items = await pbPublic(ids.wCms, "solo-aprobado");
  assert.equal(items.length, 1);
  const row = items[0];
  for (const k of ["organization", "client", "article", "publication", "article_version"]) assert.ok(!(k in row), `leaks ${k}`);
  const s = JSON.stringify(row);
  for (const k of ["brief", "outline", "claims", "qa_", "pipeline_state", "provenance", "generation_input", "cost", PRIVATE_TEXT]) assert.ok(!s.includes(k), `leaks ${k}`);
  assert.equal(row.revision.length, 16);
  // no website param → nothing; other website → nothing
  const none = await (await fetch(`${PB_URL}/api/collections/published_content/records`)).json();
  assert.equal(none.items.length, 0);
  assert.equal((await pbPublic(ids.wNext, "solo-aprobado")).length, 0);
  // filtering on hidden fields is refused / leaks nothing
  const hidden = await fetch(`${PB_URL}/api/collections/published_content/records?website=${ids.wCms}&filter=${encodeURIComponent(`organization = "${ids.orgA}"`)}`);
  assert.ok(hidden.status !== 200 || (await hidden.json()).items.length === 0);
  // Anonymous users cannot see articles/versions/claims at all
  for (const col of ["articles", "article_versions", "article_claims", "article_research", "article_qa_reports", "integrations", "publish_jobs", "article_publications"]) {
    const r = await (await fetch(`${PB_URL}/api/collections/${col}/records`)).json();
    assert.equal((r.items || []).length, 0, col);
  }
  // unapproved article of same website is not public
  const d = await mkArticle(ids.wCms, ids.cA, ids.orgA, "borrador", { status: "draft" });
  assert.equal((await pbPublic(ids.wCms, d.slug)).length, 0);
  assert.equal((await fetch(`${SITE}/cms/${ids.wCms}/blog/borrador`)).status, 404);
});

test("sitemap contains the published article", async () => {
  const xml = await (await fetch(`${SITE}/cms/${ids.wCms}/sitemap.xml`)).text();
  assert.ok(xml.includes(`/cms/${ids.wCms}/blog/solo-aprobado</loc>`));
});

test("slug collision: another article with the same slug is refused (SLUG_CONFLICT)", async () => {
  const c = await mkArticle(ids.wCms, ids.cA, ids.orgA, "solo-aprobado", { title: "Otro artículo" });
  await approve("editor", c.id);
  const p = await op("admin", "preview", { articleId: c.id });
  assert.equal(p.slug_conflict, true);
  await rejects(op("admin", "publish", { articleId: c.id, confirm: true }), "SLUG_CONFLICT");
  assert.equal((await pbPublic(ids.wCms, "solo-aprobado"))[0].title, "Paneles solares solo-aprobado", "original untouched");
});

test("version lock: edits after approval require re-approval; published content unchanged", async () => {
  await rejects(op("admin", "publish", { articleId: ids.a1, confirm: true }), "NOT_PUBLISHABLE"); // already live / status published
  // human edit creates a new version and does NOT touch the live page
  await contentOp("editor", "edit", { articleId: ids.a1, fields: { content: "# Paneles solares solo-aprobado\n\nVersión dos del contenido." }, reason: "update test" });
  const a = await admin.collection("articles").getOne(ids.a1);
  assert.equal(a.current_version, 2);
  assert.equal(a.approved_version, 1);
  const live = (await pbPublic(ids.wCms, "solo-aprobado"))[0];
  assert.ok(!live.content.includes("Versión dos"), "live content not silently modified");
  await rejects(op("admin", "publish", { articleId: ids.a1, confirm: true }), "NOT_PUBLISHABLE");
  // tampering with DB content after approval is detected at request time
  const t = await mkArticle(ids.wCms, ids.cA, ids.orgA, "manipulado");
  await approve("editor", t.id);
  await admin.collection("articles").update(t.id, { content: "tampered after approval" });
  await rejects(op("admin", "publish", { articleId: t.id, confirm: true }), "NOT_PUBLISHABLE");
});

test("update publication with a newly approved version (same URL, history kept)", async () => {
  // simulate QA recheck result for v2 (content worker is covered by Phase 4 tests)
  await admin.collection("articles").update(ids.a1, { status: "awaiting_approval", qa_status: "PASS", fact_check_status: "passed" });
  await approve("editor", ids.a1);
  const p = await op("admin", "preview", { articleId: ids.a1 });
  assert.equal(p.operation, "update");
  const j = await op("admin", "publish", { articleId: ids.a1, confirm: true, operation: "update" });
  const again = await op("admin", "publish", { articleId: ids.a1, confirm: true, operation: "update" });
  assert.equal(again.id, j.id);
  const pubBefore = await admin.collection("article_publications").getOne(ids.pub1);
  const out = await runWorker(2);
  assert.equal(out[0].status, "published", JSON.stringify(out));
  const pub = await admin.collection("article_publications").getOne(ids.pub1);
  assert.equal(pub.article_version, 2);
  assert.equal(pub.public_url, pubBefore.public_url, "no new URL");
  assert.equal(pub.published_at, pubBefore.published_at, "first publish time preserved");
  assert.equal((await admin.collection("article_publications").getFullList({ filter: `article = "${ids.a1}"` })).length, 1);
  const live = (await pbPublic(ids.wCms, "solo-aprobado"))[0];
  assert.ok(live.content.includes("Versión dos"));
  assert.equal((await admin.collection("published_content").getFullList({ filter: `article = "${ids.a1}"` })).length, 1);
  const acts = (await admin.collection("activity_logs").getFullList({ filter: `entity_id = "${ids.a1}"` })).map((l) => l.action);
  assert.ok(acts.includes("PUBLICATION_UPDATED"));
});

test("rollback to the previously published version", async () => {
  const { versions } = await op("admin", "versions", { articleId: ids.a1 });
  assert.equal(versions.length, 2);
  const v1 = versions.find((v) => v.version === 1);
  await rejects(op("admin", "rollback", { articleId: ids.a1, eventId: v1.event }), "CONFIRMATION_REQUIRED");
  await rejects(op("adminB", "rollback", { articleId: ids.a1, eventId: v1.event, confirm: true }), "NOT_FOUND");
  const r = await op("admin", "rollback", { articleId: ids.a1, eventId: v1.event, confirm: true });
  const out = await runWorker(2);
  assert.equal(out[0].status, "published", JSON.stringify(out));
  const live = (await pbPublic(ids.wCms, "solo-aprobado"))[0];
  assert.equal(live.revision, v1.hash.slice(0, 16));
  assert.ok(!live.content.includes("Versión dos"));
  const pub = await admin.collection("article_publications").getOne(ids.pub1);
  assert.equal(pub.article_version, 1);
  const a = await admin.collection("articles").getOne(ids.a1);
  assert.equal(a.current_version, 2, "newer versions are not destroyed");
  const ev = await admin.collection("publication_events").getFullList({ filter: `article = "${ids.a1}" && operation = "rollback"` });
  assert.equal(ev.length, 1);
  const acts = (await admin.collection("activity_logs").getFullList({ filter: `entity_id = "${ids.a1}"` })).map((l) => l.action);
  assert.ok(acts.includes("PUBLICATION_ROLLED_BACK"));
  assert.ok(r.id);
});

test("unpublish: URL 404, sitemap and public API exclude it, history kept", async () => {
  await rejects(op("admin", "unpublish", { articleId: ids.a1 }), "CONFIRMATION_REQUIRED");
  await op("admin", "unpublish", { articleId: ids.a1, confirm: true });
  const out = await runWorker(2);
  assert.equal(out[0].status, "unpublished", JSON.stringify(out));
  assert.equal((await fetch(`${SITE}/cms/${ids.wCms}/blog/solo-aprobado`)).status, 404);
  assert.equal((await pbPublic(ids.wCms, "solo-aprobado")).length, 0);
  const xml = await (await fetch(`${SITE}/cms/${ids.wCms}/sitemap.xml`)).text();
  assert.ok(!xml.includes("solo-aprobado"));
  const pub = await admin.collection("article_publications").getOne(ids.pub1);
  assert.equal(pub.status, "unpublished");
  assert.equal((await admin.collection("published_content").getFullList({ filter: `article = "${ids.a1}"` })).length, 1, "soft-hidden, not deleted");
  assert.equal((await admin.collection("articles").getOne(ids.a1)).status, "unpublished");
  const ops = (await admin.collection("publication_events").getFullList({ filter: `article = "${ids.a1}"`, sort: "created_at" })).map((e) => `${e.operation}:${e.status}`);
  assert.deepEqual(ops, ["publish:success", "update:success", "rollback:success", "unpublish:success"]);
  const acts = (await admin.collection("activity_logs").getFullList({ filter: `entity_id = "${ids.a1}"` })).map((l) => l.action);
  assert.ok(acts.includes("ARTICLE_UNPUBLISHED"));
});

test("Next.js API publisher: signed publish, remote_id + returned URL, verify", async () => {
  const a = await mkArticle(ids.wNext, ids.cA, ids.orgA, "next-articulo");
  await approve("editor", a.id);
  await op("admin", "publish", { articleId: a.id, confirm: true });
  const out = await runWorker(2);
  assert.equal(out[0].status, "published", JSON.stringify(out));
  const pub = (await admin.collection("article_publications").getFullList({ filter: `article = "${a.id}"` }))[0];
  assert.match(pub.remote_id, /^r-/);
  assert.equal(pub.public_url, `${SITE}/next/${ids.wNext}/blog/next-articulo`);
  const stored = site.store.get(`${ids.wNext}:next-articulo`);
  for (const k of ["brief", "claims", "qa_status", "research", "provenance", "organization"]) assert.ok(!(k in stored), `payload leaks ${k}`);
  ids.aNext = a.id;
});

test("webhook signature: invalid, expired, replayed and wrong-website requests are refused", async () => {
  const wid = ids.wNext;
  const body = JSON.stringify({ operation: "ping", website_id: wid });
  const url = `${SITE}/next/${wid}/api`;
  const post = (headers, b = body) => fetch(url, { method: "POST", headers: { "content-type": "application/json", [HEADERS.website]: wid, ...headers }, body: b });
  assert.equal((await post({})).status, 401);
  assert.equal((await post(sign("wrong-secret-0000000000000", body))).status, 401);
  assert.equal((await post(sign(site.secrets[wid], body, { timestamp: Math.floor(Date.now() / 1000) - 3600 }))).status, 401);
  const h = sign(site.secrets[wid], body);
  assert.equal((await post(h)).status, 200);
  const replay = await post(h);
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).code, "REPLAY");
  assert.equal((await post(sign(site.secrets[wid], body), body.replace("ping", "unpublish"))).status, 401, "tampered body");
  assert.equal((await fetch(url, { method: "POST", headers: { [HEADERS.website]: ids.wB, ...sign(site.secrets[wid], body) }, body })).status, 403);
});

test("API 200 but page missing → verification_required; Verify Again without re-publishing", async () => {
  await configure("admin", ids.wHook, "webhook", "hook");
  const a = await mkArticle(ids.wHook, ids.cA, ids.orgA, "hook-articulo");
  await approve("editor", a.id);
  site.hidePages = true;
  await op("admin", "publish", { articleId: a.id, confirm: true });
  const out = await runWorker(2);
  site.hidePages = false;
  assert.equal(out[0].status, "verification_required", JSON.stringify(out));
  const pub = (await admin.collection("article_publications").getFullList({ filter: `article = "${a.id}"` }))[0];
  assert.equal(pub.status, "verification_required");
  assert.equal((await admin.collection("articles").getOne(a.id)).status, "publish_failed");
  // publishing again must not create a second job/page: it becomes an update of the same publication
  const reqsBefore = site.store.size;
  await op("admin", "verify", { articleId: a.id });
  const v = await runWorker(2);
  assert.equal(v[0].status, "published", JSON.stringify(v));
  assert.equal(site.store.size, reqsBefore, "no second page");
  assert.equal((await admin.collection("article_publications").getFullList({ filter: `article = "${a.id}"` })).length, 1);
  assert.equal((await admin.collection("articles").getOne(a.id)).status, "published");
});

test("retry with backoff (max 3) then publish_failed with safe error", async () => {
  const a = await mkArticle(ids.wNext, ids.cA, ids.orgA, "reintentos");
  await approve("editor", a.id);
  site.failPublish = 10;
  const j = await op("admin", "publish", { articleId: a.id, confirm: true });
  for (let i = 1; i <= 3; i++) {
    const r = await runWorker(1);
    const job = await admin.collection("publish_jobs").getOne(j.id);
    assert.equal(job.attempt, i);
    if (i < 3) {
      assert.equal(r[0].status, "queued");
      assert.ok(Date.parse(job.next_attempt_at) > Date.now(), "backoff scheduled");
      assert.equal((await runWorker(1)).length, 0, "not due yet");
      await admin.collection("publish_jobs").update(j.id, { next_attempt_at: new Date(Date.now() - 1000).toISOString() });
    } else {
      assert.equal(r[0].status, "failed");
      assert.equal(job.error_code, "TARGET_UNAVAILABLE");
      assert.ok(!job.error_message.includes(site.secrets[ids.wNext]));
    }
  }
  site.failPublish = 0;
  assert.equal((await admin.collection("articles").getOne(a.id)).status, "publish_failed");
  assert.ok((await admin.collection("activity_logs").getFullList({ filter: `entity_id = "${a.id}" && action = "PUBLISH_FAILED"` })).length >= 1);
  // a failed job can be retried by a new human request
  const again = await op("admin", "publish", { articleId: a.id, confirm: true });
  assert.notEqual(again.id, j.id);
  assert.equal((await runWorker(2))[0].status, "published");
});

test("WordPress adapter basic path: create, update, unpublish (draft)", async () => {
  await configure("admin", ids.wWp, "wordpress", "wp");
  assert.equal((await admin.collection("websites").getOne(ids.wWp)).connection_status, "connected");
  const a = await mkArticle(ids.wWp, ids.cA, ids.orgA, "wp-articulo");
  await approve("editor", a.id);
  await op("admin", "publish", { articleId: a.id, confirm: true });
  assert.equal((await runWorker(2))[0].status, "published");
  const pub = (await admin.collection("article_publications").getFullList({ filter: `article = "${a.id}"` }))[0];
  const post = site.wp.posts.get(Number(pub.remote_id));
  assert.equal(post.slug, "wp-articulo");
  assert.ok(!post.content.includes("<script>"), "HTML sanitized");
  assert.equal(pub.public_url, post.link, "URL returned by WordPress");
  await op("admin", "unpublish", { articleId: a.id, confirm: true });
  assert.equal((await runWorker(2))[0].status, "unpublished");
  assert.equal(site.wp.posts.get(Number(pub.remote_id)).status, "draft", "not deleted");
});

test("cancelled queued job restores approved state; publishing disabled blocks", async () => {
  const a = await mkArticle(ids.wNext, ids.cA, ids.orgA, "cancelado");
  await approve("editor", a.id);
  const j = await op("admin", "publish", { articleId: a.id, confirm: true });
  await rejects(op("adminB", "cancel", { jobId: j.id }), "NOT_FOUND");
  await op("admin", "cancel", { jobId: j.id });
  assert.equal((await admin.collection("articles").getOne(a.id)).status, "approved");
  await op("admin", "config", { websiteId: ids.wNext, publisherType: "nextjs_api", enabled: false, allowedDomains: ["127.0.0.1"], baseUrl: `${SITE}/next/${ids.wNext}`, apiEndpoint: `${SITE}/next/${ids.wNext}/api`, sitemapUrl: `${SITE}/next/${ids.wNext}/sitemap.xml` });
  await rejects(op("admin", "publish", { articleId: a.id, confirm: true }), "NOT_PUBLISHABLE");
});

test("secret rotation keeps previous secret only for the grace window", async () => {
  const before = await admin.collection("integrations").getFirstListItem(`website = "${ids.wCms}"`);
  const r = await op("admin", "secret", { websiteId: ids.wCms, secret: "rotated-secret-value-1234567890", graceHours: 2 });
  assert.equal(r.rotated, true);
  assert.equal(r.secret, undefined, "a provided secret is never echoed");
  const after = await admin.collection("integrations").getFirstListItem(`website = "${ids.wCms}"`);
  assert.ok(after.previous_secret_encrypted && after.previous_secret_encrypted === before.secret_encrypted);
  assert.ok(Date.parse(after.previous_secret_valid_until) > Date.now());
  assert.equal((await admin.collection("websites").getOne(ids.wCms)).connection_status, "not_configured", "re-test required after rotation");
});
