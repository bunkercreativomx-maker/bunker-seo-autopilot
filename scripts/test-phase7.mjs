// Phase 7 — Autopilot orchestration integration tests (local PocketBase only).
//
// Real hooks + real Phase 4 content pipeline (fake AI provider) + real Phase 5
// publisher engine against a local fake staging site. Human actions go through
// the same user-token endpoints the dashboard uses. Autopilot never approves.
//
//   PB_URL=http://127.0.0.1:8097 PB_ADMIN_EMAIL=… PB_ADMIN_PASSWORD=… \
//   PUBLISHING_KEY_FILE=… node --experimental-strip-types --test --test-concurrency=1 scripts/test-phase7.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import PocketBase from "pocketbase";
import { randomUUID } from "node:crypto";
import { assertLocalTarget } from "./lib/local-only.mjs";
import { processContentJob } from "../content-worker/src/pipeline.js";
import { loadContentConfig } from "../content-worker/src/config.js";
import { claimNextJob, processJob } from "../publisher-worker/src/engine.js";
import { loadKey } from "../publisher-worker/src/secrets.js";
import { verify as verifySig, memoryNonceStore } from "../publisher-worker/src/signing.js";
import { Engine } from "../autopilot-worker/src/engine.js";

const PB_URL = process.env.PB_URL || "http://127.0.0.1:8097";
assertLocalTarget(PB_URL, "test-phase7");
const ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;
const PORT = 3399;
const SITE = `http://127.0.0.1:${PORT}`;
const PASS = "Phase7Test!2026";
const TAG = `p7-${randomUUID().slice(0, 8)}`;
const NOW = () => new Date().toISOString();
const WORKER_ENV = { ...process.env, BSA_PUBLISH_PRIVATE_ALLOWLIST: `127.0.0.1:${PORT}`, PB_PUBLIC_READ_URL: PB_URL };
const quiet = { log() {}, warn() {}, error() {} };
const CONFIG = loadContentConfig({ AI_PROVIDER: "null", AI_MAX_RETRIES: "0", AI_TIMEOUT_MS: "5000", WRITER_TIMEOUT_MS: "5000", MAX_AI_CALLS_PER_ARTICLE: "40", MAX_REVISION_CYCLES: "2", MAX_RESEARCH_SOURCES: "3" });

let admin;
let key;
const ids = {};
const users = {};
const clients = new Map();

// ---------------------------------------------------------------- fake staging site (PocketBase CMS publisher)
const site = { secrets: {}, nonces: memoryNonceStore() };
const escH = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
async function pbPublic(websiteId, slug) {
  const qs = new URLSearchParams({ website: websiteId });
  if (slug) qs.set("filter", `slug = "${slug}"`);
  const r = await fetch(`${PB_URL}/api/collections/published_content/records?${qs}`);
  return (await r.json()).items || [];
}
function readBody(req) { return new Promise((res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => res(b)); }); }
function send(res, status, body, type = "application/json") { res.writeHead(status, { "content-type": type }); res.end(typeof body === "string" ? body : JSON.stringify(body)); }
const server = http.createServer(async (req, res) => {
  const parts = new URL(req.url, SITE).pathname.split("/").filter(Boolean);
  try {
    if (parts[0] === "cms") {
      const wid = parts[1];
      if (parts[2] === "sitemap.xml") return send(res, 200, `<?xml version="1.0"?><urlset>${(await pbPublic(wid)).map((a) => `<url><loc>${escH(`${SITE}/cms/${wid}/blog/${a.slug}`)}</loc></url>`).join("")}</urlset>`, "application/xml");
      if (parts[2] === "blog" && !parts[3]) return send(res, 200, "<html>blog</html>", "text/html");
      if (parts[2] === "blog" && parts[3]) {
        const a = (await pbPublic(wid, parts[3]))[0];
        return a ? send(res, 200, `<!doctype html><html><head><title>${escH(a.seo_title || a.title)}</title><meta name="bunker-content-revision" content="${escH(a.revision || "")}"></head><body><h1>${escH(a.title)}</h1></body></html>`, "text/html") : send(res, 404, "nf", "text/html");
      }
      if (parts[2] === "revalidate" && req.method === "POST") {
        const body = await readBody(req);
        const v = await verifySig({ secrets: [site.secrets[wid]], body, headers: req.headers, nonceStore: site.nonces });
        return v.ok ? send(res, 200, { ok: true }) : send(res, 401, { ok: false, code: v.code });
      }
    }
    send(res, 404, "nf", "text/plain");
  } catch (e) { send(res, 500, { error: String(e.message) }); }
});

// ---------------------------------------------------------------- fake AI (Phase 4 pipeline stays authoritative)
function evidenceOf(input) {
  const start = input.indexOf("<untrusted_evidence>\n") + "<untrusted_evidence>\n".length;
  const end = input.lastIndexOf("\n</untrusted_evidence>");
  return JSON.parse(input.slice(start, end));
}
const BODY = [
  "Instalar paneles solares en un comercio es una decisión que conviene revisar con calma. Antes de elegir un sistema, es importante conocer el consumo del negocio, la orientación del techo y el espacio disponible para los módulos.",
  "El primer paso es revisar los recibos de luz de los últimos meses. Con esa información se puede estimar el tamaño del sistema y la cantidad de módulos que necesita el local, sin sobredimensionar la instalación.",
  "Después se hace una visita técnica para revisar la estructura, las sombras y la conexión eléctrica. Con esos datos se prepara una propuesta clara que explica cada componente y el proceso de instalación.",
  "Una vez instalado, el sistema requiere mantenimiento sencillo: limpieza periódica de los módulos y una revisión del inversor. Esto ayuda a que la producción de energía se mantenga estable durante el año.",
];
const BODY_REST = [
  "Una cocina comercial consume mucha electricidad durante el servicio de comida y cena. Refrigeradores, campanas de extracción y cámaras frías funcionan durante muchas horas, por eso conviene medir el consumo antes de pensar en energía solar.",
  "El techo de un restaurante suele tener equipos de aire acondicionado y ductos. La visita técnica revisa qué zonas quedan libres, cómo se moverían las sombras y si la estructura soporta los módulos sin afectar la ventilación.",
  "La instalación se programa en horarios sin servicio para no interrumpir la operación del local. El equipo coordina con el encargado los cortes de energía necesarios y deja el sistema funcionando antes de la apertura.",
  "Después de instalar, el personal puede revisar la producción diaria desde el inversor. La grasa y el polvo del ambiente hacen recomendable una limpieza de módulos más frecuente que en una vivienda.",
];
const BODY_GYM = [
  "Un gimnasio tiene horarios largos, caminadoras eléctricas, iluminación y aire acondicionado encendidos buena parte del día. Por eso conviene revisar primero el recibo de luz y detectar en qué horas se concentra el gasto.",
  "La azotea de un gimnasio suele ser amplia y plana, lo que facilita acomodar los módulos. En la visita técnica se revisan las sombras de edificios vecinos y la ruta del cableado hasta el tablero principal.",
  "La instalación se coordina en horarios de menor afluencia para que los socios puedan seguir entrenando. Al terminar se explica al encargado cómo leer la producción en la pantalla del inversor.",
  "El polvo y la lluvia ensucian los módulos con el tiempo. Una limpieza programada y una revisión anual de conexiones mantienen el sistema produciendo de forma estable.",
];
const BODY_HOTEL = [
  "Un hotel consume energía todo el día: lavandería, calentadores de agua, elevadores y climatización de habitaciones. Revisar el recibo de varios meses ayuda a ver en qué temporada sube más el gasto.",
  "Las azoteas de los hoteles suelen tener tinacos, antenas y equipos de clima. La visita técnica ubica las áreas libres de sombra y define por dónde bajará el cableado hacia el cuarto eléctrico.",
  "El trabajo se programa para no molestar a los huéspedes, evitando ruido en horarios de descanso. Al final se capacita al personal de mantenimiento para revisar la producción diaria.",
  "Con el tiempo el polvo reduce la producción de los módulos. Una rutina de limpieza y una inspección anual de conexiones mantienen el sistema trabajando de forma pareja.",
];
function draft(ev, note = "") {
  const phone = ev.verified_facts?.find((f) => f.type === "phone")?.value || "";
  const kw = String(ev.meta?.primary_keyword || "");
  const B = /hotel/.test(kw) ? BODY_HOTEL : /gimnas/.test(kw) ? BODY_GYM : /restaurant/.test(kw) ? BODY_REST : BODY;
  const h1 = /hotel/.test(kw) ? "Paneles solares para hoteles: qué revisar" : /gimnas/.test(kw) ? "Paneles solares para gimnasios: qué revisar" : /restaurant/.test(kw) ? "Paneles solares para restaurantes: lo que hay que revisar" : "Paneles solares para comercios: cómo empezar";
  return [`# ${h1}`, "", B[0], "", "## Qué revisar antes de instalar", "", B[1], "", "## Cómo es el proceso", "", B[2], "", "## Mantenimiento", "", B[3] + (note ? ` ${note}` : ""), "", "## Contacto", "", `Para una visita técnica llama al ${phone}.`].join("\n");
}
function makeProvider() {
  const fid = (ev, t) => ev.verified_facts?.find((f) => f.type === t)?.id;
  const handlers = {
    research_analysis: ({ ev }) => ({ search_intent: "Informarse sobre paneles solares para comercios", audience: "Dueños de negocio", questions: ["¿Qué se revisa?"], required_facts: fid(ev, "phone") ? [{ fact: "Teléfono", availability: "verified_fact", evidence_ids: [fid(ev, "phone")] }] : [], existing_content_summary: "Servicios de instalación.", internal_link_candidates: [], content_gaps: ["Proceso"], claims_requiring_sources: [], do_not_claim: ["Precios", "Garantías"], risks: [], risk_categories: [], recommended_angle: "Guía práctica", research_sufficiency: "sufficient", sufficiency_reason: "", time_sensitive: false }),
    brief_generation: ({ ev }) => ({ primary_keyword: ev.meta.primary_keyword, secondary_keywords: ["energía solar comercial"], intent: "commercial", audience: "Negocios", content_type: ev.meta.content_type, goal: "Educar", conversion_goal: "Visita", target_location: ev.meta.target_location, angle: "Guía", key_questions: ["¿Qué revisar?"], required_sections: [{ heading_idea: "Proceso", purpose: "Explicar" }], business_facts: fid(ev, "phone") ? [{ statement: "Teléfono", evidence_id: fid(ev, "phone") }] : [], external_facts: [], internal_links: [], cta: "Solicitar visita", things_to_avoid: ["Precios"], target_length: { min_words: 200, max_words: 700, rationale: "Acotado" } }),
    outline_generation: ({ ev }) => ({ h1: "Paneles solares para comercios", sections: [{ level: 2, heading: "Qué revisar", purpose: "Preparación", evidence_ids: fid(ev, "phone") ? [fid(ev, "phone")] : [], internal_link_ids: [], cta: false }], faq: [], cta_placement: "Final" }),
    draft_generation: ({ ev }) => ({ title: "Paneles solares para comercios", content_markdown: draft(ev), used_evidence_ids: [], notes_for_editor: "" }),
    revision: ({ ev }) => ({ title: "Paneles solares para comercios", content_markdown: draft(ev, "Recomendamos revisar el inversor cada temporada."), change_summary: "Título y cierre mejorados." }),
    metadata: ({ ev }) => /restaurant/.test(String(ev.meta?.primary_keyword || "")) ? ({ seo_title: "Paneles solares para restaurantes: qué revisar", meta_description: "Consumo de una cocina comercial, revisión del techo, instalación sin interrumpir el servicio y limpieza de módulos en restaurantes.", slug: "paneles-solares-restaurantes", excerpt: "Guía para restaurantes.", og_title: "Paneles solares para restaurantes", og_description: "Guía.", secondary_keywords: [], schema_suggestions: [{ type: "BlogPosting", applicable: true, reason: "Artículo" }] }) : ({ seo_title: "Paneles solares para comercios: cómo empezar", meta_description: "Qué revisar antes de instalar paneles solares en un comercio, cómo es el proceso de instalación y qué mantenimiento necesita el sistema.", slug: "paneles-solares-comercios", excerpt: "Guía práctica para comercios.", og_title: "Paneles solares para comercios", og_description: "Guía.", secondary_keywords: [], schema_suggestions: [{ type: "BlogPosting", applicable: true, reason: "Artículo" }] }),
    claim_extraction: () => ({ claims: [{ claim: "El sistema requiere limpieza periódica", claim_type: "general", business_specific: false, sensitive_topic: "none" }] }),
    fact_check: ({ ev }) => ({ results: ev.claims.map((c) => ({ claim_index: c.index, verification_status: "NOT_REQUIRED", evidence_ids: [], risk_level: "low", action: "approve", notes: "", suggested_rewrite: "" })) }),
    qa: () => ({ checks: [{ check: "search_intent", status: "pass", details: "ok" }], issues: [], summary: "Útil y claro.", score: 84 }),
  };
  return {
    name: "fake", calls: [],
    async generateStructured({ input, schemaName }) {
      this.calls.push(schemaName);
      const ev = evidenceOf(input);
      return { value: await handlers[schemaName]({ ev }), usage: { inputTokens: 100, outputTokens: 50, estimatedCost: null } };
    },
  };
}
const researchProvider = { name: "fake-search", available: true, async search() { return []; } };
const fetcher = async (url) => ({ ok: true, status: 200, finalUrl: url, text: "Instalación de paneles solares para negocios y residencias en Ciudad Juárez.", title: "Página" });

async function runContentJobs(articleId) {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const jobs = await admin.collection("content_jobs").getFullList({ filter: `article = "${articleId}" && status = "queued"` });
    if (!jobs.length) break;
    for (const job of jobs) {
      const running = await admin.collection("content_jobs").update(job.id, { status: "running", started_at: NOW(), updated_at: NOW() });
      out.push(await processContentJob(admin, running, { provider: makeProvider(), researchProvider, config: CONFIG, fetcher, logger: quiet }));
    }
  }
  return out;
}
async function runPublisher(max = 5) {
  const results = [];
  for (let i = 0; i < max; i++) {
    const job = await claimNextJob(admin, new Date(), `organization = "${ids.orgA}" || organization = "${ids.orgB}"`);
    if (!job) break;
    results.push({ job: job.id, ...(await processJob(admin, job, { env: WORKER_ENV, key, logger: quiet })) });
  }
  return results;
}

// ---------------------------------------------------------------- helpers
class OpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
async function call(user, path, body = {}) {
  try { return await clients.get(user).send(`/api/bsa/${path}`, { method: "POST", body, requestKey: null }); } catch (e) { throw new OpError(e.status, e.response?.code, e.response?.message || String(e)); }
}
const ap = (user, path, body) => call(user, `autopilot/${path}`, body);
const rejects = async (p, code) => { await assert.rejects(p, (e) => { assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`); return true; }); };
const list = (col, filter, opts = {}) => admin.collection(col).getFullList({ filter, ...opts });
const count = async (col, filter) => (await list(col, filter, { fields: "id" })).length;
function engine(extra = {}) { return new Engine(admin, { logger: quiet, workerId: `test-${TAG}`, staleQueueMs: 365 * 86400000, ...extra }); }
async function jobCounts(websiteId) {
  const f = `website = "${websiteId}"`;
  return { crawl: await count("crawl_jobs", f), strategy: await count("strategy_jobs", f), content: await count("content_jobs", f), publish: await count("publish_jobs", f), articles: await count("articles", f) };
}
async function runAndProcess(user, websiteId, dry = false) {
  const r = await ap(user, dry ? "dry-run" : "run", { websiteId });
  await engine().processRun(r.run.id);
  return admin.collection("autopilot_runs").getOne(r.run.id);
}
async function pendingTriggers(websiteId) { return list("autopilot_triggers", `website = "${websiteId}" && status = "pending"`); }

async function mkWebsite(org, client, name) {
  return admin.collection("websites").create({ organization: org, client, name: `${TAG} ${name}`, domain: `${TAG}-${name}.example.test`, platform: "custom", primary_language: "es", status: "active", created_at: NOW() });
}
let svSeq = 0;
async function strategyFixture(t) {
  const sv = await admin.collection("strategy_versions").create({ ...t, version: ++svSeq, summary: "v1", generated_at: NOW(), created_at: NOW(), updated_at: NOW() });
  await admin.collection("crawl_jobs").create({ ...t, status: "completed", completed_at: NOW(), created_at: NOW() });
  const kw = async (k, intent = "commercial") => (await admin.collection("keywords").create({ ...t, strategy_version: sv.id, keyword: k, normalized_keyword: k, language: "es", source: "services", status: "approved", intent, created_at: NOW(), updated_at: NOW() })).id;
  const opp = async (k, extra = {}) => (await admin.collection("content_opportunities").create({ ...t, strategy_version: sv.id, keyword: await kw(k), opportunity_type: "create", recommended_page_type: "blog_article", recommended_url: `/blog/${k.replace(/\s+/g, "-")}`, title_suggestion: k, reason: "Hueco de contenido aprobado en Phase 3", priority: "high", status: "approved", evidence: [{ type: "fixture" }], created_at: NOW(), updated_at: NOW(), ...extra })).id;
  return { sv: sv.id, opp, kw };
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
  const cA = await admin.collection("clients").create({ organization: orgA.id, business_name: `${TAG} Solar A`, slug: `${TAG}-ca`, primary_language: "es", services: "Instalación de paneles solares", primary_location: "Ciudad Juárez", status: "active", created_at: NOW() });
  const cB = await admin.collection("clients").create({ organization: orgB.id, business_name: `${TAG} Solar B`, slug: `${TAG}-cb`, primary_language: "es", status: "active", created_at: NOW() });
  Object.assign(ids, { orgA: orgA.id, orgB: orgB.id, cA: cA.id, cB: cB.id });
  ids.w = (await mkWebsite(orgA.id, cA.id, "main")).id;     // full content → publish flow
  ids.w2 = (await mkWebsite(orgA.id, cA.id, "ops")).id;     // budgets / circuit / kill switch
  ids.wB = (await mkWebsite(orgB.id, cB.id, "b")).id;       // other tenant
  for (const [name, org, role] of [["admin", orgA.id, "admin"], ["editor", orgA.id, "editor"], ["viewer", orgA.id, "viewer"], ["adminB", orgB.id, "admin"]]) {
    const u = await admin.collection("users").create({ email: `${TAG}-${name}@test.local`, password: PASS, passwordConfirm: PASS, name: `${TAG} ${name}`, organization: org, role, status: "active" });
    users[name] = u;
    const pb = new PocketBase(PB_URL);
    pb.autoCancellation(false);
    await pb.collection("users").authWithPassword(u.email, PASS);
    clients.set(name, pb);
  }
  const A = { organization: orgA.id, client: cA.id, website: ids.w };
  await admin.collection("business_facts").create({ ...A, fact_type: "phone", label: "Teléfono", value: "656 695 3960", source: "user", verified: true, verification_state: "verified", provenance: "user_provided", created_at: NOW() });
  await admin.collection("website_pages").create({ ...A, url: `https://${TAG}-main.example.test/`, normalized_url: `https://${TAG}-main.example.test/`, path: "/", title: "Paneles solares en Juárez", h1: "Paneles", status_code: 200, indexable: true, created_at: NOW() });
  const s = await strategyFixture(A);
  ids.oppMain = await s.opp("paneles solares para comercios");
  ids.oppFacts = await s.opp("precio de paneles solares con financiamiento");
  ids.oppIgnored = await s.opp("mantenimiento de paneles solares", { status: "skipped" });
  // no-GSC-data state: property exists, zero rows
  const conn = await admin.collection("gsc_connections").create({ organization: orgA.id, status: "connected", created_at: NOW() });
  ids.gscConn = conn.id;
  ids.gscProp = (await admin.collection("gsc_properties").create({ organization: orgA.id, connection: conn.id, website: ids.w, site_url: `sc-domain:${TAG}-main.example.test`, property_type: "domain", status: "active", selected: true })).id;
  // publishing: staging PocketBase CMS target (Phase 5 config endpoints, admin token)
  await call("admin", "publishing/config", { websiteId: ids.w, publisherType: "pocketbase_cms", publishingMode: "manual", environment: "staging", enabled: true, allowedDomains: ["127.0.0.1"], baseUrl: `${SITE}/cms/${ids.w}`, blogPath: "/blog", revalidateUrl: `${SITE}/cms/${ids.w}/revalidate`, sitemapUrl: `${SITE}/cms/${ids.w}/sitemap.xml`, verifySitemap: true });
  site.secrets[ids.w] = (await call("admin", "publishing/secret", { websiteId: ids.w, generate: true })).secret;
  await call("admin", "publishing/test", { websiteId: ids.w });
  await runPublisher(1);
  const B2 = { organization: orgA.id, client: cA.id, website: ids.w2 };
  const s2 = await strategyFixture(B2);
  ids.oppOps = await s2.opp("paneles solares industriales");
});

after(async () => {
  server.close();
  if (!admin) return;
  const cols = ["autopilot_outcomes", "autopilot_circuits", "autopilot_tasks", "autopilot_run_events", "autopilot_triggers", "autopilot_actions", "autopilot_decisions", "autopilot_signals", "autopilot_runs", "autopilot_policies", "autopilot_controls", "notifications",
    "gsc_site_daily", "gsc_page_daily", "analytics_opportunities", "gsc_properties", "gsc_connections",
    "publication_events", "published_content", "publish_jobs", "article_publications", "integrations", "content_taxonomies", "ai_usage", "content_jobs", "article_claims", "article_versions", "articles",
    "content_opportunities", "keywords", "strategy_versions", "crawl_jobs", "strategy_jobs", "business_facts", "website_pages", "activity_logs"];
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

// ================================================================= POLICY
test("P7 policy: default OFF for every website, safe defaults, FULL_AUTO refused", async () => {
  for (const w of [ids.w, ids.w2, ids.wB]) {
    const p = await admin.collection("autopilot_policies").getFirstListItem(`website = "${w}"`);
    assert.equal(p.enabled, false);
    assert.equal(p.mode, "OFF");
    assert.equal(p.require_human_publish_approval, true);
    assert.equal(p.publish_after_human_approval, false);
    assert.equal(p.pause_on_high_risk, true);
    assert.equal(p.pause_on_fact_failure, true);
    assert.equal(p.pause_on_integration_error, true);
    assert.deepEqual(p.allowed_environments, ["staging"]);
  }
  const g = await ap("viewer", "policy", { websiteId: ids.w });
  assert.equal(g.policy.mode, "OFF");
  assert.equal(g.can_edit, false);
  assert.equal(g.policy.full_auto_available, false);
  await rejects(ap("admin", "policy/save", { websiteId: ids.w, mode: "FULL_AUTO", enabled: true }), "FEATURE_DISABLED");
  await rejects(ap("admin", "policy/save", { websiteId: ids.w, requireHumanPublishApproval: false }), "INVALID");
  await rejects(ap("admin", "policy/save", { websiteId: ids.w, pauseOnHighRisk: false }), "INVALID");
  await rejects(ap("admin", "policy/save", { websiteId: ids.w, mode: "OFF", enabled: true }), "INVALID");
  await rejects(ap("admin", "run", { websiteId: ids.w }), "AUTOPILOT_OFF");
});

test("P7 policy: only admins change it; viewer/editor/cross-tenant refused; direct writes refused", async () => {
  await rejects(ap("viewer", "policy/save", { websiteId: ids.w, mode: "OBSERVE", enabled: true }), "FORBIDDEN");
  await rejects(ap("editor", "policy/save", { websiteId: ids.w, mode: "OBSERVE", enabled: true }), "FORBIDDEN");
  await rejects(ap("editor", "pause", { websiteId: ids.w }), "FORBIDDEN");
  await rejects(ap("adminB", "policy/save", { websiteId: ids.w, mode: "SUPERVISED", enabled: true }), "NOT_FOUND");
  await rejects(ap("adminB", "policy", { websiteId: ids.w }), "NOT_FOUND");
  await rejects(ap("adminB", "run", { websiteId: ids.w }), "NOT_FOUND");
  await rejects(ap("adminB", "dry-run", { websiteId: ids.w }), "NOT_FOUND");
  await rejects(ap("adminB", "pause", { websiteId: ids.w }), "NOT_FOUND");
  await rejects(ap("viewer", "dry-run", { websiteId: ids.w }), "FORBIDDEN");
  const pol = await admin.collection("autopilot_policies").getFirstListItem(`website = "${ids.w}"`);
  await assert.rejects(clients.get("admin").collection("autopilot_policies").update(pol.id, { enabled: true, mode: "SUPERVISED" }));
  await assert.rejects(clients.get("admin").collection("autopilot_runs").create({ organization: ids.orgA, client: ids.cA, website: ids.w, status: "queued", trigger: "manual" }));
  await assert.rejects(clients.get("admin").collection("autopilot_actions").create({ organization: ids.orgA, client: ids.cA, website: ids.w, action_type: "PUBLISH", status: "planned", idempotency_key: "forged" }));
  await assert.rejects(clients.get("admin").collection("activity_logs").create({ organization: ids.orgA, action: "AUTOPILOT_ENABLED" }));
  // tenant read isolation on the new collections
  assert.equal((await clients.get("adminB").collection("autopilot_policies").getFullList({ filter: `website = "${ids.w}"` })).length, 0);
  assert.equal((await clients.get("viewer").collection("autopilot_policies").getFullList({ filter: `website = "${ids.w}"` })).length, 1);
  // internal endpoints need the worker superuser
  await assert.rejects(clients.get("admin").send("/api/bsa/internal/autopilot/execute", { method: "POST", body: {} }), (e) => e.status === 401 || e.status === 403);
});

test("P7 policy preview shows consequences; publish-after-approval explained", async () => {
  const pv = await ap("admin", "policy/preview", { websiteId: ids.w, mode: "SUPERVISED", enabled: true, publishAfterHumanApproval: true });
  assert.equal(pv.consequences.mode, "SUPERVISED");
  assert.ok(pv.consequences.can.some((c) => /Generate drafts/.test(c)));
  assert.ok(pv.consequences.cannot.some((c) => /Approve content/.test(c)));
  assert.equal(pv.consequences.publish_after_human_approval, true);
  assert.match(pv.consequences.publish_explanation, /staging/);
  const off = await ap("admin", "policy/preview", { websiteId: ids.w, mode: "SUPERVISED", enabled: true, publishAfterHumanApproval: false });
  assert.match(off.consequences.publish_explanation, /never publishes by itself/);
  // preview does not save
  assert.equal((await admin.collection("autopilot_policies").getFirstListItem(`website = "${ids.w}"`)).enabled, false);
});

// ================================================================= DRY RUN (policy still OFF)
test("P7 dry run: plan with evidence, creates NO crawl/strategy/content/publish job", async () => {
  const before = await jobCounts(ids.w);
  const run = await runAndProcess("admin", ids.w, true);
  assert.equal(run.status, "completed");
  assert.equal(run.dry_run, true);
  const dr = run.result.dry_run;
  assert.equal(dr.would_generate_content, true);
  assert.equal(dr.would_refresh_crawl, false);
  assert.equal(dr.would_refresh_strategy, false);
  assert.match(dr.would_publish, /^no/);
  assert.ok(dr.content.some((c) => c.opportunity === ids.oppMain));
  assert.match(dr.analytics, /WAIT_FOR_MORE_DATA/);
  assert.match(String(dr.estimated_ai_usage.cost), /^unknown/, "unknown cost is never reported as $0");
  assert.deepEqual(await jobCounts(ids.w), before, "dry run executed nothing");
  assert.equal(await count("autopilot_actions", `run = "${run.id}"`), 0);
  const decisions = await list("autopilot_decisions", `run = "${run.id}"`);
  const gen = decisions.find((d) => d.decision_type === "CREATE_CONTENT" && d.evidence.opportunity === ids.oppMain);
  assert.ok(gen, "content decision recorded");
  assert.equal(gen.status, "dry_run");
  assert.equal(gen.evidence.phase3_priority, "high");
  assert.match(gen.explanation, /Trigger: dry_run/);
  // missing business facts → human review, never generation
  const facts = decisions.find((d) => d.rule === "content.missing_business_facts");
  assert.ok(facts);
  assert.deepEqual(facts.evidence.missing_facts.sort(), ["financing", "price"]);
  // skipped (ignored) opportunity is not eligible
  assert.ok(!decisions.some((d) => d.evidence?.opportunity === ids.oppIgnored));
  // no data ≠ bad performance
  assert.ok(decisions.some((d) => d.decision_type === "WAIT_FOR_MORE_DATA"));
  const sigs = await list("autopilot_signals", `website = "${ids.w}"`);
  assert.ok(!sigs.some((s) => ["CONTENT_DECAY", "LOW_CTR", "STRIKING_DISTANCE", "NEW_QUERY"].includes(s.signal_type)));
});

test("P7 signals: dedup across runs (no duplicates, seen_count grows)", async () => {
  const before = await list("autopilot_signals", `website = "${ids.w}"`);
  await runAndProcess("admin", ids.w, true);
  const afterRun = await list("autopilot_signals", `website = "${ids.w}"`);
  assert.equal(afterRun.length, before.length);
  assert.equal(new Set(afterRun.map((s) => s.dedup_key)).size, afterRun.length);
  const s = afterRun.find((x) => x.source_record === ids.oppMain);
  assert.ok(s.seen_count >= 2);
});

// ================================================================= OBSERVE
test("P7 OBSERVE: recommendations only — no jobs", async () => {
  await ap("admin", "policy/save", { websiteId: ids.w, mode: "OBSERVE", enabled: true, schedule: "manual_only" });
  const before = await jobCounts(ids.w);
  const run = await runAndProcess("admin", ids.w);
  assert.ok(["completed", "completed_with_warnings"].includes(run.status), run.status);
  assert.deepEqual(await jobCounts(ids.w), before);
  const acts = await list("autopilot_actions", `run = "${run.id}"`);
  const gen = acts.find((a) => a.action_type === "GENERATE_CONTENT");
  assert.equal(gen.status, "skipped");
  assert.equal(gen.error_code, "OBSERVE_MODE");
  // human-review tasks are still raised (recommendation, not a job)
  assert.ok((await list("autopilot_tasks", `website = "${ids.w}" && kind = "missing_facts"`)).length === 1);
  const logs = await list("activity_logs", `website = "${ids.w}" && action = "AUTOPILOT_ENABLED"`);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].user, users.admin.id);
});

// ================================================================= SUPERVISED content → approval → publish
test("P7 SUPERVISED: queues Phase 4, stops at awaiting_approval, never approves", async () => {
  await ap("admin", "policy/save", { websiteId: ids.w, mode: "SUPERVISED", enabled: true, publishAfterHumanApproval: true, maxContentJobsPerDay: 2, maxContentJobsPerWeek: 3 });
  const run = await runAndProcess("admin", ids.w);
  ids.run = run.id;
  assert.equal(run.status, "monitoring", "content job in flight");
  const gen = (await list("autopilot_actions", `run = "${run.id}" && action_type = "GENERATE_CONTENT"`))[0];
  assert.equal(gen.target_id, ids.oppMain);
  assert.equal(gen.status, "running");
  assert.equal(gen.job_type, "content_job");
  assert.equal(gen.idempotency_key, `generate:${ids.w}:opp:${ids.oppMain}`);
  assert.equal(gen.policy_snapshot.publish_after_human_approval, true);
  ids.article = gen.article;
  const art0 = await admin.collection("articles").getOne(ids.article);
  assert.equal(art0.content_opportunity, ids.oppMain);
  // Phase 4 runs (content worker) — Autopilot does not touch the pipeline
  await runContentJobs(ids.article);
  const art = await admin.collection("articles").getOne(ids.article);
  assert.equal(art.status, "awaiting_approval", `${art.status} qa=${art.qa_status} fc=${art.fact_check_status}`);
  // event continuation: the article_ready trigger resumes the SAME run
  assert.ok((await pendingTriggers(ids.w)).some((t) => t.trigger === "article_ready"));
  await engine().tick();
  const r2 = await admin.collection("autopilot_runs").getOne(ids.run);
  assert.equal(r2.status, "waiting_for_approval");
  assert.equal((await admin.collection("autopilot_actions").getOne(gen.id)).status, "completed", "operational success = reached awaiting_approval");
  assert.equal((await admin.collection("articles").getOne(ids.article)).approved_by, "", "Autopilot never approves");
  assert.equal(await count("publish_jobs", `article = "${ids.article}"`), 0);
  const task = (await list("autopilot_tasks", `website = "${ids.w}" && kind = "article_approval" && status = "open"`))[0];
  assert.ok(task, "Needs Your Attention: article approval");
  assert.ok((await list("activity_logs", `website = "${ids.w}" && action = "AUTOPILOT_WAITING_APPROVAL"`)).length >= 1);
  // an idle tick does not change anything (no polling loop on approvals)
  await engine().tick();
  assert.equal((await admin.collection("autopilot_runs").getOne(ids.run)).status, "waiting_for_approval");
  assert.equal(await count("publish_jobs", `article = "${ids.article}"`), 0);
});

test("P7 human gate: the worker cannot publish an unapproved article (internal execute refuses)", async () => {
  const fake = await admin.collection("autopilot_actions").create({ organization: ids.orgA, client: ids.cA, website: ids.w, run: ids.run, action_type: "PUBLISH", target_type: "article", target_id: ids.article, article: ids.article, status: "planned", idempotency_key: `forged-publish-${TAG}`, policy_snapshot: { allowed_actions: ["PUBLISH"], allowed_environments: ["staging"], publish_after_human_approval: true }, created_at: NOW(), updated_at: NOW() });
  await assert.rejects(admin.send("/api/bsa/internal/autopilot/execute", { method: "POST", body: { actionId: fake.id } }), (e) => e.response?.code === "NOT_APPROVED");
  await admin.collection("autopilot_actions").update(fake.id, { status: "cancelled" });
  assert.equal(await count("publish_jobs", `article = "${ids.article}"`), 0);
});

test("P7 approval resumes Autopilot → Phase 5 publish to staging automatically → verified", async () => {
  // Human approval through the normal Phase 4 endpoint (editor token).
  await call("editor", "content/approve", { articleId: ids.article });
  const approved = await admin.collection("articles").getOne(ids.article);
  assert.equal(approved.status, "approved");
  assert.equal(approved.approved_by, users.editor.id);
  const trig = (await pendingTriggers(ids.w)).filter((t) => t.trigger === "article_approved");
  assert.equal(trig.length, 1);
  await engine().tick();
  const pubActs = await list("autopilot_actions", `website = "${ids.w}" && action_type = "PUBLISH" && status != "cancelled"`);
  assert.equal(pubActs.length, 1, `one publish action: ${JSON.stringify(pubActs.map((a) => [a.status, a.error_code, a.error_message, a.run]))}`);
  assert.equal(pubActs[0].run, ids.run, "same logical workflow");
  assert.equal(pubActs[0].idempotency_key, `publish:${ids.article}:${approved.approved_hash}`);
  const jobs = await list("publish_jobs", `article = "${ids.article}"`);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].article_version, approved.approved_version);
  // same event twice → one logical action (dedup'd trigger + idempotent action)
  await assert.rejects(admin.collection("autopilot_triggers").create({ organization: ids.orgA, client: ids.cA, website: ids.w, trigger: "article_approved", entity_type: "article", entity_id: ids.article, payload: {}, dedup_key: trig[0].dedup_key, status: "pending", created_at: NOW(), updated_at: NOW() }));
  await engine().processRun(ids.run);
  assert.equal(await count("publish_jobs", `article = "${ids.article}"`), 1);
  assert.equal(await count("autopilot_actions", `website = "${ids.w}" && action_type = "PUBLISH" && status != "cancelled"`), 1);
  // Phase 5 publisher publishes to the staging target
  const res = await runPublisher(3);
  assert.ok(res.some((r) => r.job === jobs[0].id));
  const job = await admin.collection("publish_jobs").getOne(jobs[0].id);
  assert.equal(job.status, "published", job.error_message);
  // publication_completed trigger → continuation → action completed, run finished
  await engine().tick();
  const act = await admin.collection("autopilot_actions").getOne(pubActs[0].id);
  assert.equal(act.status, "completed");
  assert.ok(act.result.public_url.startsWith(`${SITE}/cms/${ids.w}/blog/`));
  const page = await fetch(act.result.public_url);
  assert.equal(page.status, 200);
  const sm = await (await fetch(`${SITE}/cms/${ids.w}/sitemap.xml`)).text();
  assert.ok(sm.includes(act.result.public_url));
  const run = await admin.collection("autopilot_runs").getOne(ids.run);
  assert.ok(["completed", "completed_with_warnings"].includes(run.status), run.status);
  assert.equal(run.result.gsc_state, "WAIT_FOR_MORE_DATA", "no GSC data → wait, not failure");
  const outcome = await admin.collection("autopilot_outcomes").getFirstListItem(`action = "${act.id}"`);
  assert.equal(outcome.status, "waiting_for_data");
  assert.equal(outcome.article_version, approved.approved_version);
  // timeline / explainability
  const events = (await list("autopilot_run_events", `run = "${ids.run}"`, { sort: "at" })).map((e) => e.kind);
  for (const k of ["run_started", "action_planned", "job_queued", "waiting_approval", "human_approved", "action_completed", "run_completed"]) assert.ok(events.includes(k), `timeline has ${k}: ${events.join(",")}`);
  const human = (await list("autopilot_run_events", `run = "${ids.run}" && kind = "human_approved"`))[0];
  assert.match(human.message, new RegExp(`${TAG} editor`));
  for (const a of ["AUTOPILOT_RUN_STARTED", "AUTOPILOT_ACTION_PLANNED", "AUTOPILOT_ACTION_STARTED", "AUTOPILOT_ACTION_COMPLETED", "AUTOPILOT_RUN_COMPLETED"]) assert.ok((await count("activity_logs", `website = "${ids.w}" && action = "${a}"`)) >= 1, a);
  // approval task closed
  assert.equal(await count("autopilot_tasks", `website = "${ids.w}" && kind = "article_approval" && status = "open"`), 0);
});

test("P7 no duplicate content: next run does not regenerate the same opportunity", async () => {
  const before = await jobCounts(ids.w);
  const run = await runAndProcess("admin", ids.w);
  const d = await list("autopilot_decisions", `run = "${run.id}"`);
  assert.ok(d.some((x) => x.rule === "content.article_exists" && x.evidence.opportunity === ids.oppMain));
  assert.equal((await jobCounts(ids.w)).content, before.content);
  assert.equal((await jobCounts(ids.w)).articles, before.articles);
});

// ================================================================= REJECTION / IGNORE / SNOOZE
test("P7 human rejection respected; not recreated next run", async () => {
  const s = await strategyFixture({ organization: ids.orgA, client: ids.cA, website: ids.w });
  ids.oppReject = await s.opp("paneles solares para restaurantes");
  const run = await runAndProcess("admin", ids.w);
  const gen = (await list("autopilot_actions", `run = "${run.id}" && action_type = "GENERATE_CONTENT"`))[0];
  assert.equal(gen.target_id, ids.oppReject);
  await runContentJobs(gen.article);
  const first = await admin.collection("articles").getOne(gen.article);
  assert.equal(first.status, "awaiting_approval", `first pass qa=${first.qa_status} fc=${first.fact_check_status} flags=${JSON.stringify(first.flags)} qa=${JSON.stringify((await list("article_qa_reports", `article = "${gen.article}"`)).map((r) => r.blockers || r.issues || r.checks)).slice(0, 1500)}`);
  await engine().tick();
  const dbg = await admin.collection("articles").getOne(gen.article);
  const dbgJobs = await list("content_jobs", `article = "${gen.article}"`);
  assert.equal(dbg.status, "awaiting_approval", `status=${dbg.status} jobs=${JSON.stringify(dbgJobs.map((j) => [j.id, j.mode, j.status, j.step, j.error_code, j.error, j.triggered_by, j.configuration, j.created_at]))} acts=${JSON.stringify((await list("autopilot_actions", `article = "${gen.article}"`)).map((a) => [a.action_type, a.status, a.job_id]))}`);
  await call("editor", "content/reject", { articleId: gen.article, reason: "No es prioridad para el cliente" });
  await engine().tick();
  const next = await runAndProcess("admin", ids.w);
  const d = await list("autopilot_decisions", `run = "${next.id}"`);
  assert.ok(d.some((x) => x.rule === "content.rejected_memory"));
  assert.equal(await count("articles", `content_opportunity = "${ids.oppReject}"`), 1, "not recreated");
  const events = (await list("autopilot_run_events", `run = "${run.id}"`)).map((e) => e.kind);
  assert.ok(events.includes("human_rejected"));
});

test("P7 ignore / snooze signals; cross-tenant refused", async () => {
  const sig = await admin.collection("autopilot_signals").getFirstListItem(`website = "${ids.w}" && source_record = "${ids.oppFacts}"`);
  await rejects(ap("viewer", "signal", { signalId: sig.id, operation: "snooze", days: 30 }), "FORBIDDEN");
  await rejects(ap("adminB", "signal", { signalId: sig.id, operation: "ignore" }), "NOT_FOUND");
  await rejects(ap("editor", "signal", { signalId: sig.id, operation: "snooze", days: 3 }), "INVALID");
  await ap("editor", "signal", { signalId: sig.id, operation: "snooze", days: 30 });
  let s = await admin.collection("autopilot_signals").getOne(sig.id);
  assert.equal(s.status, "snoozed");
  const run = await runAndProcess("admin", ids.w, true);
  assert.ok(!(await list("autopilot_decisions", `run = "${run.id}"`)).some((d) => d.signal === sig.id), "snoozed signal not evaluated");
  s = await admin.collection("autopilot_signals").getOne(sig.id);
  assert.equal(s.status, "snoozed", "still snoozed after run");
  await ap("editor", "signal", { signalId: sig.id, operation: "ignore" });
  assert.equal((await admin.collection("autopilot_signals").getOne(sig.id)).status, "ignored");
  assert.ok((await count("activity_logs", `website = "${ids.w}" && (action = "AUTOPILOT_SIGNAL_SNOOZED" || action = "AUTOPILOT_SIGNAL_IGNORED")`)) >= 2);
});

// ================================================================= PAUSE / KILL SWITCH / BUDGET / CIRCUIT (ops website)
test("P7 pause/resume: paused website creates no run; resume allows again", async () => {
  await ap("admin", "policy/save", { websiteId: ids.w2, mode: "SUPERVISED", enabled: true, schedule: "daily" });
  await ap("admin", "pause", { websiteId: ids.w2, reason: "acceptance" });
  await rejects(ap("admin", "run", { websiteId: ids.w2 }), "AUTOPILOT_PAUSED");
  // schedule does not fire for paused websites
  await admin.collection("autopilot_policies").update((await admin.collection("autopilot_policies").getFirstListItem(`website = "${ids.w2}"`)).id, { next_run_at: new Date(Date.now() - 60000).toISOString() });
  assert.equal((await engine().schedule()).length, 0);
  await ap("admin", "resume", { websiteId: ids.w2 });
  const created = await engine().schedule();
  assert.equal(created.length, 1, "scheduler creates the due run after resume");
  const r = await admin.collection("autopilot_runs").getOne(created[0]);
  assert.equal(r.trigger, "scheduled");
  // pause while a run is queued → worker stops it before acting
  await ap("admin", "pause", { websiteId: ids.w2 });
  await engine().processRun(r.id);
  const stopped = await admin.collection("autopilot_runs").getOne(r.id);
  assert.ok(["paused", "cancelled"].includes(stopped.status), stopped.status);
  assert.equal(await count("autopilot_actions", `run = "${r.id}" && status = "running"`), 0);
  await ap("admin", "resume", { websiteId: ids.w2 });
  for (const a of ["AUTOPILOT_PAUSED", "AUTOPILOT_RESUMED"]) assert.ok((await count("activity_logs", `website = "${ids.w2}" && action = "${a}"`)) >= 1);
});

test("P7 organization kill switch stops new runs; restore", async () => {
  await rejects(ap("editor", "org/pause", {}), "FORBIDDEN");
  await ap("admin", "org/pause", { reason: "kill switch test" });
  await rejects(ap("admin", "run", { websiteId: ids.w2 }), "AUTOPILOT_PAUSED");
  const before = await count("autopilot_runs", `website = "${ids.w2}"`);
  await admin.collection("autopilot_triggers").create({ organization: ids.orgA, client: ids.cA, website: ids.w2, trigger: "crawl_completed", entity_type: "crawl_job", entity_id: "x", payload: {}, dedup_key: `ks-${TAG}`, status: "pending", created_at: NOW(), updated_at: NOW() });
  await engine().tick();
  assert.equal(await count("autopilot_runs", `website = "${ids.w2}"`), before, "no new runs under kill switch");
  assert.equal((await admin.collection("autopilot_triggers").getFirstListItem(`dedup_key = "ks-${TAG}"`)).status, "ignored");
  // other org unaffected
  assert.equal((await ap("adminB", "policy", { websiteId: ids.wB })).organization_paused, false);
  await ap("admin", "org/resume", {});
  const r = await ap("admin", "run", { websiteId: ids.w2 });
  assert.equal(r.created, true);
  await engine().processRun(r.run.id);
  assert.ok((await count("activity_logs", `organization = "${ids.orgA}" && action = "AUTOPILOT_PAUSED" && entity_type = "autopilot_control"`)) === 1);
});

test("P7 budget: tiny limit → BUDGET_LIMIT, nothing spent; restore", async () => {
  // w2 already generated one article (previous test) → weekly limit 1 is exhausted
  await ap("admin", "policy/save", { websiteId: ids.w2, maxContentJobsPerDay: 1, maxContentJobsPerWeek: 1 });
  const s = await strategyFixture({ organization: ids.orgA, client: ids.cA, website: ids.w2 });
  ids.oppBudget = await s.opp("paneles solares para bodegas");
  const before = await jobCounts(ids.w2);
  const dry = await runAndProcess("admin", ids.w2, true);
  const blocked = (await list("autopilot_decisions", `run = "${dry.id}" && block_code = "BUDGET_LIMIT"`));
  assert.ok(blocked.length >= 1, "dry run reports BUDGET_LIMIT");
  assert.match(blocked[0].reason, /limit/);
  const run = await runAndProcess("admin", ids.w2);
  const acts = await list("autopilot_actions", `run = "${run.id}" && action_type = "GENERATE_CONTENT"`);
  assert.ok(acts.every((a) => a.status === "blocked" && a.error_code === "BUDGET_LIMIT"));
  assert.equal((await jobCounts(ids.w2)).content, before.content, "no content job beyond the limit");
  assert.ok((await count("activity_logs", `website = "${ids.w2}" && action = "AUTOPILOT_BUDGET_PAUSED"`)) >= 1);
  assert.equal(await count("autopilot_tasks", `website = "${ids.w2}" && kind = "budget_limit"`), 1, "notified once (dedup)");
  await ap("admin", "policy/save", { websiteId: ids.w2, maxContentJobsPerDay: 1, maxContentJobsPerWeek: 3 });
});

test("P7 circuit breaker: 3 publisher AUTH failures pause publisher actions only", async () => {
  const e = engine();
  const scope = { id: "", organization: ids.orgA, client: ids.cA, website: ids.w2 };
  for (let i = 0; i < 3; i++) await e.circuit(scope, "PUBLISH", "AUTH", "UNAUTHORIZED");
  const c = await admin.collection("autopilot_circuits").getFirstListItem(`website = "${ids.w2}" && action_type = "PUBLISH"`);
  assert.equal(c.state, "open");
  assert.ok((await count("activity_logs", `website = "${ids.w2}" && action = "AUTOPILOT_CIRCUIT_OPENED"`)) === 1);
  assert.equal(await count("autopilot_tasks", `website = "${ids.w2}" && kind = "circuit_open"`), 1);
  const { gate } = await import("../autopilot-worker/src/decide.js");
  const usage = { actions_today: 0, content_today: 0, content_week: 0, publications_week: 0, strategy_week: 0, crawls_week: 0, ai_calls_today: 0, ai_tokens_today: 0, ai_cost_today: { known: null, unknown_calls: 0 }, ai_cost_month: { known: null, unknown_calls: 0 } };
  const ctx = { policy: e.policyView({ enabled: true, mode: "SUPERVISED" }), circuits: { PUBLISH: "open" }, health: {}, usage, website: {} };
  assert.equal(gate("PUBLISH", ctx, []).code, "CIRCUIT_OPEN");
  assert.equal(gate("GENERATE_CONTENT", ctx, []), null, "other safe actions continue");
  await rejects(ap("editor", "circuit/reset", { circuitId: c.id }), "FORBIDDEN");
  await rejects(ap("adminB", "circuit/reset", { circuitId: c.id }), "NOT_FOUND");
  await ap("admin", "circuit/reset", { circuitId: c.id });
  assert.equal((await admin.collection("autopilot_circuits").getOne(c.id)).state, "closed");
});

// ================================================================= STATE MACHINE / LEASE / CANCEL
test("P7 state machine rejects invalid transitions", async () => {
  const done = (await list("autopilot_runs", `website = "${ids.w}" && status = "completed"`))[0];
  await assert.rejects(admin.send("/api/bsa/internal/autopilot/transition", { method: "POST", body: { kind: "run", id: done.id, to: "executing" } }), (e) => e.response?.code === "INVALID_TRANSITION");
  const cancelled = await admin.collection("autopilot_runs").create({ organization: ids.orgA, client: ids.cA, website: ids.wB2 || ids.w2, dry_run: true, status: "cancelled", trigger: "manual", created_at: NOW(), updated_at: NOW() });
  await assert.rejects(admin.send("/api/bsa/internal/autopilot/transition", { method: "POST", body: { kind: "run", id: cancelled.id, to: "executing" } }), (e) => e.response?.code === "INVALID_TRANSITION");
  const act = (await list("autopilot_actions", `website = "${ids.w}" && status = "completed"`))[0];
  await assert.rejects(admin.send("/api/bsa/internal/autopilot/transition", { method: "POST", body: { kind: "action", id: act.id, to: "running" } }), (e) => e.response?.code === "INVALID_TRANSITION");
});

test("P7 lease: one owner at a time; expired lease can be taken over", async () => {
  const r = await admin.collection("autopilot_runs").create({ organization: ids.orgA, client: ids.cA, website: ids.w2, dry_run: true, status: "queued", trigger: "manual", created_at: NOW(), updated_at: NOW() });
  const lease = (owner, extra = {}) => admin.send("/api/bsa/internal/autopilot/lease", { method: "POST", body: { runId: r.id, owner, seconds: 60, ...extra } }).then((x) => x.result);
  assert.equal((await lease("w1")).acquired, true);
  assert.equal((await lease("w2")).acquired, false);
  assert.equal((await lease("w1")).acquired, true, "owner renews");
  await admin.collection("autopilot_runs").update(r.id, { lease_until: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await lease("w2")).acquired, true, "expired lease taken over");
  // a second engine replica cannot process a leased run
  const res = await engine({ workerId: "other" }).processRun(r.id);
  assert.equal(res.skipped, "leased");
  await lease("w2", { release: true });
  await admin.collection("autopilot_runs").update(r.id, { status: "cancelled" });
});

test("P7 single active run per website: second request merges", async () => {
  const pol = await admin.collection("autopilot_policies").getFirstListItem(`website = "${ids.w2}"`);
  assert.equal(pol.enabled, true);
  const a = await ap("admin", "run", { websiteId: ids.w2 });
  const b = await ap("admin", "run", { websiteId: ids.w2 });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.run.id, a.run.id);
  await assert.rejects(admin.collection("autopilot_runs").create({ organization: ids.orgA, client: ids.cA, website: ids.w2, dry_run: false, status: "queued", trigger: "manual", created_at: NOW(), updated_at: NOW() }), "unique active-run index");
  await engine().processRun(a.run.id);
});

test("P7 manual cancellation of a planned action is respected (not recreated)", async () => {
  // policy allows only NOTIFY so the GENERATE action stays blocked → cancel it
  const s = await strategyFixture({ organization: ids.orgA, client: ids.cA, website: ids.w2 });
  const opp = await s.opp("paneles solares para escuelas");
  await ap("admin", "policy/save", { websiteId: ids.w2, maxContentJobsPerWeek: 20, maxContentJobsPerDay: 5, allowedActions: ["NOTIFY_HUMAN", "WAIT"] });
  const run = await runAndProcess("admin", ids.w2);
  const act = (await list("autopilot_actions", `run = "${run.id}" && target_id = "${opp}"`))[0];
  assert.equal(act.status, "blocked");
  assert.equal(act.error_code, "POLICY_NOT_ALLOWED");
  await rejects(ap("adminB", "action/cancel", { actionId: act.id }), "NOT_FOUND");
  await rejects(ap("viewer", "action/cancel", { actionId: act.id }), "FORBIDDEN");
  await ap("editor", "action/cancel", { actionId: act.id });
  assert.equal((await admin.collection("autopilot_actions").getOne(act.id)).status, "cancelled");
  await ap("admin", "policy/save", { websiteId: ids.w2, allowedActions: ["CRAWL", "STRATEGY_REFRESH", "GENERATE_CONTENT", "RECHECK_CONTENT", "REQUEST_REVISION", "PUBLISH", "VERIFY_PUBLICATION", "UPDATE_PUBLICATION", "NOTIFY_HUMAN", "WAIT"] });
  const next = await runAndProcess("admin", ids.w2);
  assert.equal(await count("articles", `content_opportunity = "${opp}"`), 0, "cancelled action not recreated");
  assert.equal(await count("autopilot_actions", `run = "${next.id}" && target_id = "${opp}" && status = "running"`), 0);
  assert.ok((await count("activity_logs", `website = "${ids.w2}" && action = "AUTOPILOT_ACTION_CANCELLED"`)) === 1);
});

test("P7 disable: new actions stop, triggers ignored", async () => {
  await ap("admin", "policy/save", { websiteId: ids.w2, enabled: false });
  await rejects(ap("admin", "run", { websiteId: ids.w2 }), "AUTOPILOT_OFF");
  assert.ok((await count("activity_logs", `website = "${ids.w2}" && action = "AUTOPILOT_DISABLED"`)) === 1);
});

// ================================================================= ANALYTICS LOOP (controlled fixture, test env only)
test("P7 analytics loop: real-data fixture → optimization = NEW version awaiting approval; published content untouched", async () => {
  const pubBefore = await list("published_content", `website = "${ids.w}"`);
  const verBefore = await count("article_versions", `article = "${ids.article}"`);
  // TEST FIXTURE ONLY: rows with impressions for this local website
  for (let i = 1; i <= 10; i++) await admin.collection("gsc_site_daily").create({ organization: ids.orgA, client: ids.cA, website: ids.w, property: ids.gscProp, date: new Date(Date.now() - i * 86400000).toISOString().slice(0, 10), search_type: "web", clicks: 2, impressions: 120, ctr: 0.016, position: 9, data_state: "final" });
  const pub = await admin.collection("article_publications").getFirstListItem(`article = "${ids.article}"`);
  const outcome = await admin.collection("autopilot_outcomes").getFirstListItem(`article = "${ids.article}"`);
  await admin.collection("autopilot_outcomes").update(outcome.id, { changed_at: new Date(Date.now() - 40 * 86400000).toISOString() });
  const opp = await admin.collection("analytics_opportunities").create({ organization: ids.orgA, client: ids.cA, website: ids.w, type: "high_impressions_low_ctr", dedupe_key: `${TAG}-ctr`, evidence: { impressions: 1200, clicks: 19 }, priority: "medium", status: "accepted", source: "gsc", page: pub.public_url, query: "paneles solares para comercios", current_period: { impressions: 1200, clicks: 19 }, recommended_action: "Mejorar el título y la meta descripción para la consulta principal.", created_at: NOW(), updated_at: NOW() });
  await ap("admin", "policy/save", { websiteId: ids.w, maxRevisionJobsPerArticle: 1 });
  const run = await runAndProcess("admin", ids.w);
  const d = (await list("autopilot_decisions", `run = "${run.id}" && decision_type = "OPTIMIZE_EXISTING_CONTENT"`))[0];
  assert.ok(d, "optimization decision");
  assert.equal(d.evidence.analytics_opportunity || d.signal ? true : false, true);
  const act = (await list("autopilot_actions", `run = "${run.id}" && action_type = "REQUEST_REVISION"`))[0];
  assert.equal(act.target_id, ids.article);
  await runContentJobs(ids.article);
  const art = await admin.collection("articles").getOne(ids.article);
  assert.equal(art.status, "awaiting_approval", `new version waits for human approval: qa=${art.qa_status} fc=${art.fact_check_status} flags=${JSON.stringify(art.flags)} jobs=${JSON.stringify((await list("content_jobs", `article = "${ids.article}"`)).map((j) => [j.mode, j.status, j.step, j.error]))}`);
  assert.ok((await count("article_versions", `article = "${ids.article}"`)) > verBefore, "new version created");
  const pubAfter = await list("published_content", `website = "${ids.w}"`);
  assert.deepEqual(pubAfter.map((p) => [p.id, p.revision, p.content]), pubBefore.map((p) => [p.id, p.revision, p.content]), "published content not modified");
  await engine().tick();
  assert.equal(await count("publish_jobs", `article = "${ids.article}" && status = "queued"`), 0, "no update without approval");
  await admin.collection("analytics_opportunities").delete(opp.id);
});

test("P7 GSC property with zero rows: WAIT_FOR_MORE_DATA, zero performance signals, no error", async () => {
  for (const r of await list("gsc_site_daily", `website = "${ids.w}"`)) await admin.collection("gsc_site_daily").delete(r.id);
  const run = await runAndProcess("admin", ids.w, true);
  assert.equal(run.status, "completed");
  const d = await list("autopilot_decisions", `run = "${run.id}"`);
  assert.ok(d.some((x) => x.decision_type === "WAIT_FOR_MORE_DATA" && x.evidence.gsc_state === "NO_DATA"));
  assert.equal(d.filter((x) => ["OPTIMIZE_EXISTING_CONTENT", "REVIEW_METADATA"].includes(x.decision_type)).length, 0);
  const active = await list("autopilot_signals", `website = "${ids.w}" && status = "active" && source = "search_console"`);
  assert.equal(active.length, 0);
});

test("P7 audit: no secrets in autopilot records or logs", async () => {
  const secret = site.secrets[ids.w];
  const dump = JSON.stringify([
    await list("autopilot_actions", `website = "${ids.w}"`), await list("autopilot_decisions", `website = "${ids.w}"`),
    await list("autopilot_runs", `website = "${ids.w}"`), await list("activity_logs", `website = "${ids.w}"`),
  ]);
  assert.ok(!dump.includes(secret));
  assert.ok(!dump.includes(ADMIN_PASSWORD));
});

// ================================================================= SIMPLE MODE (daily posts)
test("P7 simple mode: daily post auto-picks a PROPOSED topic, writes it, still waits for human approval", async () => {
  const w3 = (await mkWebsite(ids.orgA, ids.cA, "daily")).id;
  const T = { organization: ids.orgA, client: ids.cA, website: w3 };
  await admin.collection("business_facts").create({ ...T, fact_type: "phone", label: "Teléfono", value: "656 695 3960", source: "user", verified: true, verification_state: "verified", provenance: "user_provided", created_at: NOW() });
  const s = await strategyFixture(T);
  const pFacts = await s.opp("precio de paneles solares", { status: "proposed" });
  const pGood = await s.opp("paneles solares para gimnasios", { status: "proposed" }); // distinct fixture body
  const pOther = await s.opp("paneles solares para hoteles", { status: "proposed", priority: "medium" });
  // Off by default: proposed topics are ignored.
  await ap("admin", "policy/save", { websiteId: w3, mode: "SUPERVISED", enabled: true, schedule: "daily", maxContentJobsPerDay: 1, maxContentJobsPerWeek: 7 });
  let run = await runAndProcess("admin", w3);
  assert.equal(await count("articles", `website = "${w3}"`), 0, "auto-pick off → nothing generated from proposed topics");
  // Editor cannot turn it on; admin can.
  await rejects(ap("editor", "policy/save", { websiteId: w3, autoPickOpportunities: true }), "FORBIDDEN");
  const saved = await ap("admin", "policy/save", { websiteId: w3, autoPickOpportunities: true });
  assert.equal(saved.policy.auto_pick_opportunities, true);
  assert.ok(saved.policy.next_run_at, "daily schedule has a next run");
  assert.equal(new Date(saved.policy.next_run_at).getUTCHours(), 13, "next morning ~7:00 Juárez");
  run = await runAndProcess("admin", w3);
  const gen = await list("autopilot_actions", `run = "${run.id}" && action_type = "GENERATE_CONTENT"`);
  assert.equal(gen.length, 1, "exactly one post per day");
  assert.equal(gen[0].target_id, pGood, "skips topic that needs unverified facts (price) quietly");
  const spam = await list("autopilot_tasks", `website = "${w3}" && status = "open" && kind != "article_approval"`);
  assert.equal(spam.length, 0, `no review spam: ${JSON.stringify(spam.map((t) => [t.kind, t.title]))}`);
  const opp = await admin.collection("content_opportunities").getOne(pGood);
  assert.equal(opp.status, "approved");
  assert.ok((await count("activity_logs", `website = "${w3}" && action = "OPPORTUNITY_AUTO_SELECTED" && entity_id = "${pGood}"`)) === 1, "auto-selection audited");
  assert.equal((await admin.collection("content_opportunities").getOne(pFacts)).status, "proposed");
  assert.equal((await admin.collection("content_opportunities").getOne(pOther)).status, "proposed");
  await runContentJobs(gen[0].article);
  const art = await admin.collection("articles").getOne(gen[0].article);
  assert.equal(art.status, "awaiting_approval", `qa=${art.qa_status} fc=${art.fact_check_status} flags=${JSON.stringify(art.flags)} summary=${JSON.stringify(art.qa_summary).slice(0, 600)}`);
  assert.equal(art.approved_by, "", "still never self-approves");
  assert.equal(await count("publish_jobs", `website = "${w3}"`), 0);
  // Same day again: daily limit → no second post.
  const again = await runAndProcess("admin", w3);
  assert.equal(await count("autopilot_actions", `run = "${again.id}" && action_type = "GENERATE_CONTENT" && status = "running"`), 0);
  await ap("admin", "policy/save", { websiteId: w3, enabled: false });
});

// ================================================================= SAFE AUTO-PUBLISH
test("P7 simple mode: safe auto-publish publishes a clean post by itself; a flagged post waits", async () => {
  const w4 = (await mkWebsite(ids.orgA, ids.cA, "autopub")).id;
  const T = { organization: ids.orgA, client: ids.cA, website: w4 };
  await admin.collection("business_facts").create({ ...T, fact_type: "phone", label: "Teléfono", value: "656 695 3960", source: "user", verified: true, verification_state: "verified", provenance: "user_provided", created_at: NOW() });
  await call("admin", "publishing/config", { websiteId: w4, publisherType: "pocketbase_cms", publishingMode: "manual", environment: "staging", enabled: true, allowedDomains: ["127.0.0.1"], baseUrl: `${SITE}/cms/${w4}`, blogPath: "/blog", revalidateUrl: `${SITE}/cms/${w4}/revalidate`, sitemapUrl: `${SITE}/cms/${w4}/sitemap.xml`, verifySitemap: true });
  site.secrets[w4] = (await call("admin", "publishing/secret", { websiteId: w4, generate: true })).secret;
  await call("admin", "publishing/test", { websiteId: w4 });
  await runPublisher(1);
  const s = await strategyFixture(T);
  const pGood = await s.opp("paneles solares para hoteles y moteles", { status: "proposed" });
  // Editor cannot switch on auto-publish.
  await rejects(ap("editor", "policy/save", { websiteId: w4, autoPublishSafe: true }), "FORBIDDEN");
  await ap("admin", "policy/save", { websiteId: w4, mode: "SUPERVISED", enabled: true, schedule: "daily", autoPickOpportunities: true, publishAfterHumanApproval: true, autoPublishSafe: true,
    allowedActions: ["CRAWL", "STRATEGY_REFRESH", "GENERATE_CONTENT", "RECHECK_CONTENT", "REQUEST_REVISION", "PUBLISH", "VERIFY_PUBLICATION", "UPDATE_PUBLICATION", "AUTO_PUBLISH", "NOTIFY_HUMAN", "WAIT"],
    maxContentJobsPerDay: 1, maxContentJobsPerWeek: 7, maxPublicationsPerWeek: 7 });
  let run = await runAndProcess("admin", w4);
  const gen = await list("autopilot_actions", `run = "${run.id}" && action_type = "GENERATE_CONTENT"`);
  assert.equal(gen.length, 1);
  assert.equal(gen[0].target_id, pGood);
  await runContentJobs(gen[0].article);
  let art = await admin.collection("articles").getOne(gen[0].article);
  assert.equal(art.status, "awaiting_approval", `qa=${art.qa_status} fc=${art.fact_check_status} flags=${JSON.stringify(art.flags)} sum=${JSON.stringify(art.qa_summary).slice(0,400)}`);
  // Fixture QA score is 84 (< 85) → held for a human even with the switch on.
  run = await runAndProcess("admin", w4);
  assert.equal(await count("autopilot_actions", `website = "${w4}" && action_type = "AUTO_PUBLISH"`), 0, "score 84 is below the safe threshold");
  const held = await list("autopilot_decisions", `website = "${w4}" && rule = "publish.auto_safe.held"`);
  assert.ok(held.length >= 1 && /score 84/.test(held[0].reason), held[0]?.reason);
  // Unsafe server-side even if a worker tried: the hook re-checks.
  // Make it clean (as QA would with a higher score) → auto-publishes.
  await admin.collection("articles").update(art.id, { qa_score: { score: 93 }, qa_status: "PASS", fact_check_status: "passed", flags: ["RESEARCH_LIMITED"], high_risk: false });
  run = await runAndProcess("admin", w4);
  const auto = await list("autopilot_actions", `website = "${w4}" && action_type = "AUTO_PUBLISH"`);
  assert.equal(auto.length, 1, JSON.stringify((await list("autopilot_decisions", `run = "${run.id}"`)).map((d) => [d.rule, d.reason])).slice(0, 1500));
  await runPublisher(5);
  run = await runAndProcess("admin", w4);
  art = await admin.collection("articles").getOne(art.id);
  assert.ok(["published", "approved", "publishing", "publish_queued"].includes(art.status), art.status);
  assert.equal(art.provenance.auto_published_by_policy, true, "provenance marks the policy approval");
  assert.ok(art.approved_by, "approval recorded under the admin who enabled auto-publish");
  assert.equal(await count("activity_logs", `website = "${w4}" && action = "ARTICLE_AUTO_APPROVED"`), 1, "audited");
  const pubs = await pbPublic(w4);
  assert.equal(pubs.length, 1, "visible on the website");
  // Public hub profile exposes only safe, verified branding.
  const profRes = await fetch(`${PB_URL}/api/bsa/public/site/${w4}`);
  const prof = await profRes.json();
  assert.equal(profRes.status, 200, JSON.stringify(prof) + JSON.stringify(await admin.collection("websites").getOne(w4, { fields: "publishing_enabled,publisher_type,base_url" })));
  assert.equal(prof.phone, "656 695 3960");
  assert.equal(prof.environment, "staging");
  assert.ok(!("organization" in prof) && !("client" in prof) && !JSON.stringify(prof).includes("secret"));
  assert.equal((await fetch(`${PB_URL}/api/bsa/public/site/${ids.w2}`)).status, 404, "unconnected website has no public profile");
  // Turning the switch off stops auto-publish.
  await ap("admin", "policy/save", { websiteId: w4, autoPublishSafe: false, enabled: false });
});
