// Phase 8 (Quick questions) integration test against a LOCAL PocketBase with
// the repo pb_hooks. Usage: PB_URL=… PB_ADMIN_EMAIL=… PB_ADMIN_PASSWORD=… node --test scripts/test-questions.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const URL = process.env.PB_URL || "http://127.0.0.1:8097";
if (!/127\.0\.0\.1|localhost/.test(URL)) throw new Error("local PB only");
const now = () => new Date().toISOString();
let su, userToken, viewerToken, org, client, site, otherSite, factUnverified;

async function call(method, path, body, token) {
  const r = await fetch(URL + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}
const create = async (coll, data) => { const r = await call("POST", `/api/collections/${coll}/records`, data, su); assert.equal(r.status, 200, `${coll}: ${JSON.stringify(r.body)}`); return r.body; };
const facts = async () => (await call("GET", `/api/collections/business_facts/records?perPage=200&filter=${encodeURIComponent(`website="${site.id}"`)}`, null, su)).body.items;

before(async () => {
  su = (await call("POST", "/api/collections/_superusers/auth-with-password", { identity: process.env.PB_ADMIN_EMAIL, password: process.env.PB_ADMIN_PASSWORD })).body.token;
  assert.ok(su, "superuser login");
  const stamp = Date.now();
  org = await create("organizations", { name: `qq-${stamp}`, slug: `qq-${stamp}`, status: "active" });
  const other = await create("organizations", { name: `qq2-${stamp}`, slug: `qq2-${stamp}`, status: "active" });
  for (const [email, role] of [[`qq-admin-${stamp}@local.test`, "admin"], [`qq-viewer-${stamp}@local.test`, "viewer"]]) {
    await create("users", { email, password: "Passw0rd!x", passwordConfirm: "Passw0rd!x", name: "QQ", organization: org.id, role, status: "active" });
    const t = (await call("POST", "/api/collections/users/auth-with-password", { identity: email, password: "Passw0rd!x" })).body.token;
    if (role === "admin") userToken = t; else viewerToken = t;
  }
  client = await create("clients", { organization: org.id, name: "Frío QQ", business_name: "Frío QQ", slug: `frio-${stamp}`, status: "active" });
  site = await create("websites", { organization: org.id, client: client.id, name: "Frío QQ", domain: `frio-${stamp}.mx`, platform: "nextjs", primary_language: "es", status: "active" });
  const oc = await create("clients", { organization: other.id, name: "Other", business_name: "Other", slug: `o-${stamp}`, status: "active" });
  otherSite = await create("websites", { organization: other.id, client: oc.id, name: "Other", domain: `o-${stamp}.mx`, platform: "nextjs", status: "active" });
  const tenant = { organization: org.id, client: client.id, website: site.id };
  await create("business_facts", { ...tenant, fact_type: "phone", label: "Teléfono", value: "656 000 0000", source: "site", verified: true, verification_state: "verified", provenance: "website", created_at: now() });
  factUnverified = await create("business_facts", { ...tenant, fact_type: "promotion", label: "Promoción", value: "10% de descuento en mantenimiento", source: "site", source_url: "https://frio.mx/promo", verified: false, verification_state: "unverified", provenance: "website", created_at: now() });
});

test("questions: unverified site facts first, then the universal bank", async () => {
  const r = await call("POST", "/api/bsa/facts/questions", { websiteId: site.id }, userToken);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const keys = r.body.questions.map((q) => q.key);
  assert.equal(keys[0], `fact:${factUnverified.id}`);
  for (const k of ["free_estimate", "warranty", "financing", "years", "review", "on_site", "same_day", "bilingual", "licensed"]) assert.ok(keys.includes(k), k);
  assert.ok(!keys.some((k) => k.includes("phone")));
});

test("answers become facts: yes = verified, no = NOT OFFERED, skip = hidden", async () => {
  let r = await call("POST", "/api/bsa/facts/answer", { websiteId: site.id, key: "warranty", answer: "yes", detail: "1 año en mano de obra" }, userToken);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call("POST", "/api/bsa/facts/answer", { websiteId: site.id, key: "same_day", answer: "no" }, userToken);
  assert.equal(r.status, 200);
  r = await call("POST", "/api/bsa/facts/answer", { websiteId: site.id, key: "years", answer: "yes", detail: "8" }, userToken);
  assert.equal(r.status, 200);
  r = await call("POST", "/api/bsa/facts/answer", { websiteId: site.id, key: "review", answer: "yes", detail: "Llegaron puntuales y dejaron todo limpio, muy recomendados." }, userToken);
  assert.equal(r.status, 200);
  r = await call("POST", "/api/bsa/facts/answer", { websiteId: site.id, key: `fact:${factUnverified.id}`, answer: "no" }, userToken);
  assert.equal(r.status, 200);
  r = await call("POST", "/api/bsa/facts/answer", { websiteId: site.id, key: "bilingual", answer: "skip" }, userToken);
  assert.equal(r.status, 200);

  const all = await facts();
  const by = (label) => all.find((f) => f.label === label);
  assert.equal(by("Garantía").verification_state, "user_confirmed");
  assert.match(by("Garantía").value, /1 año en mano de obra/);
  assert.equal(by("Garantía").fact_type, "warranty");
  assert.match(by("Servicio el mismo día o de emergencia").value, /^NOT OFFERED/);
  assert.equal(by("Servicio el mismo día o de emergencia").fact_type, "other");
  assert.match(by("Años en el negocio").value, /^8 años en el negocio$/);
  assert.match(by("Reseña de cliente (testimonios)").value, /^“Llegaron puntuales/);
  const promo = all.find((f) => f.id === factUnverified.id);
  assert.match(promo.value, /^NOT OFFERED: Promoción — 10% de descuento/);
  assert.equal(promo.manual_override, true);

  const left = (await call("POST", "/api/bsa/facts/questions", { websiteId: site.id }, userToken)).body.questions.map((q) => q.key);
  for (const k of ["warranty", "same_day", "years", "review", "bilingual", `fact:${factUnverified.id}`]) assert.ok(!left.includes(k), `still asked: ${k}`);
  assert.ok(left.includes("financing"));
});

test("validation and permissions", async () => {
  assert.equal((await call("POST", "/api/bsa/facts/answer", { websiteId: site.id, key: "licensed", answer: "maybe" }, userToken)).status, 400);
  assert.equal((await call("POST", "/api/bsa/facts/answer", { websiteId: site.id, key: "years", answer: "no" }, userToken)).status, 400);
  assert.equal((await call("POST", "/api/bsa/facts/answer", { websiteId: site.id, key: "nope", answer: "yes" }, userToken)).status, 400);
  assert.equal((await call("POST", "/api/bsa/facts/answer", { websiteId: site.id, key: "licensed", answer: "yes" }, viewerToken)).status, 403);
  assert.equal((await call("POST", "/api/bsa/facts/answer", { websiteId: otherSite.id, key: "licensed", answer: "yes" }, userToken)).status, 404);
  assert.equal((await call("POST", "/api/bsa/facts/questions", { websiteId: otherSite.id }, userToken)).status, 404);
  assert.equal((await call("POST", "/api/bsa/facts/answer", { websiteId: site.id, key: "licensed", answer: "yes" })).status, 401);
  // users still cannot write facts directly
  const direct = await call("POST", "/api/collections/business_facts/records", { organization: org.id, client: client.id, website: site.id, fact_type: "other", label: "x", value: "x", source: "x" }, userToken);
  assert.ok(direct.status >= 400);
});

test("org-wide list (Today) includes only the actor's sites", async () => {
  const r = await call("POST", "/api/bsa/facts/questions", {}, userToken);
  assert.equal(r.status, 200);
  assert.ok(r.body.questions.length > 0);
  assert.ok(r.body.questions.every((q) => q.websiteId === site.id));
});
