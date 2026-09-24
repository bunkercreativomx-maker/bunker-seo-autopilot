// Phase 4 editorial calibration (acceptance feedback): verified-only business
// facts, silent omission, no editorial notes / reader warnings, no external
// links on commercial pages, stable technical knowledge as NOT_REQUIRED,
// official-source-first research, DNS failures are not SSRF blocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { attachSources, buildContext, evidenceIndex } from "../src/context.js";
import { enforceClaim, externalLinks, isStableGeneralKnowledge, processLinks, scanEditorialLanguage } from "../src/checks.js";
import { researchQueries } from "../src/pipeline.js";
import { fetchSource } from "../src/research.js";
import { runDraft } from "../src/stages.js";

const T = { organization: "org1", client: "cliA", website: "webA" };
function data(contentType = "service_page") {
  return {
    article: { id: "art1", ...T, content_type: contentType, primary_keyword: "instalación de paneles solares", language: "es", target_location: "Ciudad Juárez", generation_input: {} },
    client: { id: "cliA", organization: "org1", business_name: "Solar A", primary_language: "es" },
    website: { id: "webA", organization: "org1", client: "cliA", domain: "solar-a.mx", primary_language: "es" },
    facts: [
      { id: "f1", ...T, fact_type: "phone", label: "Teléfono", value: "656 695 3960", verified: true, verification_state: "user_confirmed", provenance: "user_provided" },
      { id: "f2", ...T, fact_type: "email", label: "Email", value: "soporte@solar-a.mx", verified: true, verification_state: "user_confirmed", provenance: "user_provided" },
      { id: "f3", ...T, fact_type: "warranty", label: "Garantía", value: "25 años", verification_state: "unverified", provenance: "website" },
    ],
    pages: [{ id: "p1", ...T, url: "https://solar-a.mx/", path: "/", title: "Inicio", h1: "Solar", indexable: true, status_code: 200 }],
    links: [], issues: [], opportunity: null, keyword: null, cluster: null, clusterKeywords: [], planItem: null, otherArticles: [],
  };
}

test("calibration: stable technical knowledge may be NOT_REQUIRED; numbers, business and sensitive topics may not", () => {
  const idx = evidenceIndex(buildContext(data()));
  const dc = enforceClaim({ claim: "Los paneles fotovoltaicos generan corriente continua", claim_type: "product", business_specific: false, sensitive_topic: "none" }, { verification_status: "NOT_REQUIRED" }, idx);
  assert.equal(dc.verification_status, "NOT_REQUIRED");
  assert.equal(dc.blocking, false);
  for (const claim of [
    { claim: "Instalamos paneles en toda la ciudad", claim_type: "business", business_specific: true, sensitive_topic: "availability" },
    { claim: "Un sistema ahorra hasta 95%", claim_type: "general", business_specific: false, sensitive_topic: "none" },
    { claim: "La CFE exige un contrato de interconexión", claim_type: "legal", business_specific: false, sensitive_topic: "legal" },
    { claim: "Los paneles tienen garantía larga", claim_type: "product", business_specific: false, sensitive_topic: "warranty" },
  ]) {
    assert.equal(isStableGeneralKnowledge(claim), false, claim.claim);
    assert.notEqual(enforceClaim(claim, { verification_status: "NOT_REQUIRED" }, idx).verification_status, "NOT_REQUIRED", claim.claim);
  }
});

test("verified contact: phone claim VERIFIED only through the user-confirmed F* fact", () => {
  const ctx = buildContext(data());
  const idx = evidenceIndex(ctx);
  assert.deepEqual(ctx.verified_facts.map((f) => f.record_id), ["f1", "f2"]);
  const ok = enforceClaim({ claim: "Llámanos al 656 695 3960", claim_type: "business", business_specific: true, sensitive_topic: "contact" }, { verification_status: "VERIFIED", evidence_ids: ["F1"] }, idx);
  assert.equal(ok.verification_status, "VERIFIED");
  const warranty = enforceClaim({ claim: "Garantía de 25 años", claim_type: "business", business_specific: true, sensitive_topic: "warranty" }, { verification_status: "VERIFIED", evidence_ids: ["U1"] }, idx);
  assert.equal(warranty.verification_status, "UNVERIFIED");
  assert.equal(warranty.blocking, true);
});

test("editorial scan: flags editor notes and reader warnings about the client; clean copy passes", () => {
  const bad = [
    "La comunicación pública de la empresa menciona garantías.",
    "Formulario sugerido (campos mínimos para captura de lead):",
    "Nota final: verifica horarios y datos antes de acudir.",
    "Si la empresa afirma financiamiento, exige los documentos contractuales que prueben esas afirmaciones.",
    "## Señales de confianza que debes solicitar antes de contratar",
    "Este texto las presenta como declaraciones del proveedor.",
  ];
  for (const line of bad) assert.equal(scanEditorialLanguage(`# H\n\n${line}`).length, 1, line);
  const good = "# Instalación de paneles solares en Ciudad Juárez\n\nInstalamos sistemas solares residenciales y comerciales en Ciudad Juárez.\n\nLlámanos al 656 695 3960 o escríbenos a soporte@solar-a.mx.\n\n## ¿Cómo funciona un sistema?\n\nLos paneles generan corriente continua y el inversor la convierte en alterna.";
  assert.deepEqual(scanEditorialLanguage(good), []);
});

test("commercial pages: external links are unlinked by processLinks and detected in copy", () => {
  const ctx = attachSources(buildContext(data()), [{ id: "s1", url: "https://www.cfe.mx/tarifas", title: "CFE", publisher: "cfe.mx", source_type: "official", excerpt: "" }]);
  const md = "# T\n\nVer [tarifas](https://cfe.mx/tarifas) e [inicio](https://solar-a.mx/).";
  const res = processLinks(md, ctx, data().pages);
  assert.ok(res.markdown.includes("Ver tarifas e [inicio](https://solar-a.mx/)"));
  assert.match(res.removed.map((r) => r.reason).join(" "), /not used on commercial pages/);
  assert.deepEqual(externalLinks("x https://solaric.com.ph/a y https://www.solar-a.mx/b", "solar-a.mx"), ["https://solaric.com.ph/a"]);
  // Blog articles may still cite a collected source.
  const blogCtx = attachSources(buildContext(data("blog_article")), [{ id: "s1", url: "https://www.cfe.mx/tarifas", title: "CFE", publisher: "cfe.mx", source_type: "official", excerpt: "" }]);
  assert.ok(processLinks(md, blogCtx, data().pages).markdown.includes("[tarifas](https://cfe.mx/tarifas)"));
});

test("research: Mexican official-source queries come first; other countries unchanged", () => {
  const ctx = buildContext(data());
  const mx = researchQueries(ctx, [], "MX");
  assert.match(mx[0], /site:gob\.mx/);
  assert.ok(mx.some((q) => /site:cfe\.mx/.test(q)));
  assert.ok(mx.some((q) => /cre\.gob\.mx/.test(q) && /conuee\.gob\.mx/.test(q)));
  assert.equal(mx.at(-1), "instalación de paneles solares");
  assert.ok(researchQueries(ctx, [], "US").every((q) => !q.includes("site:")));
});

test("research: DNS failure is reported as unreachable, not as an SSRF block", async () => {
  const dnsFail = await fetchSource("https://no-such-host-bunker-seo.invalid/x");
  assert.equal(dnsFail.ok, false);
  assert.equal(dnsFail.ssrfBlocked, false);
  const priv = await fetchSource("http://127.0.0.1:9/x");
  assert.equal(priv.ssrfBlocked, true);
});

test("writer prompt: verified contacts, silent omission, no external links on service pages", async () => {
  const ctx = buildContext(data());
  let seen = "";
  const provider = { name: "capture", async generateStructured(req) { seen = req.instructions; return { value: { title: "t", content_markdown: `# Instalación de paneles solares en Ciudad Juárez\n\n${"texto ".repeat(60)}`, used_evidence_ids: [], notes_for_editor: "" }, usage: { inputTokens: 1, outputTokens: 1, estimatedCost: null } }; } };
  const budget = { assertCanCall() {}, record() {}, snapshot() { return {}; } };
  await runDraft({ provider, config: { models: { draft_generation: "m" }, retries: 0, timeoutMs: 1000, writerTimeoutMs: 1000 }, budget, onUsage: async () => {} }, ctx, { do_not_claim: [], questions: [], recommended_angle: "" }, {}, {}).catch(() => {});
  assert.match(seen, /656 695 3960/);
  assert.match(seen, /soporte@solar-a\.mx/);
  assert.match(seen, /OMITTED ENTIRELY/);
  assert.match(seen, /Do NOT put external links/);
  assert.match(seen, /first person plural/);
  assert.doesNotMatch(seen, /25 años/, "unverified warranty is never offered as a CTA/contact detail");
});
