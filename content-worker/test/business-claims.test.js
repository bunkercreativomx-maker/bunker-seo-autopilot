// Phase 4 fix round 2: business claims need a matching verified fact (website
// evidence never suffices, model cannot declassify), strict omission of
// unverified business facts, navigation/UI text is not a claim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext, evidenceIndex } from "../src/context.js";
import { enforceClaim, factSupportsClaim, isBusinessClaim, isNonClaimText, scanUnverifiedBusinessMentions } from "../src/checks.js";

const T = { organization: "org1", client: "cliA", website: "webA" };
function data() {
  return {
    article: { id: "art1", ...T, content_type: "service_page", primary_keyword: "instalación de paneles solares", language: "es", target_location: "Ciudad Juárez", generation_input: {} },
    client: { id: "cliA", organization: "org1", business_name: "Tlaloc Solfuturo", primary_language: "es" },
    website: { id: "webA", organization: "org1", client: "cliA", domain: "tlalocsolfuturo.com", primary_language: "es" },
    facts: [
      { id: "f1", ...T, fact_type: "phone", label: "Teléfono", value: "656 695 3960", verified: true, verification_state: "user_confirmed", provenance: "user_provided" },
      { id: "f2", ...T, fact_type: "email", label: "Email", value: "Soporte@solfuturo.com.mx", verified: true, verification_state: "user_confirmed", provenance: "user_provided" },
      { id: "f3", ...T, fact_type: "service_area", label: "Zona principal", value: "Ciudad Juárez", verified: true, verification_state: "user_confirmed", provenance: "user_provided" },
      { id: "f4", ...T, fact_type: "service", label: "Servicios", value: "Instalación solar residencial y comercial", verified: true, verification_state: "user_confirmed", provenance: "user_provided" },
      { id: "u1", ...T, fact_type: "warranty", label: "Garantía instalación (sitio web)", value: "Garantía de por vida en la instalación", verification_state: "unverified", provenance: "website" },
      { id: "u2", ...T, fact_type: "certification", label: "Certificaciones (sitio web)", value: "100% Certificados", verification_state: "unverified", provenance: "website" },
      { id: "u3", ...T, fact_type: "other", label: "Proyectos (sitio web)", value: "+500 instalaciones activas", verification_state: "unverified", provenance: "website" },
      { id: "u4", ...T, fact_type: "service", label: "Servicios (sitio web)", value: "Residencial, comercial, industrial (100 kW–2 MW), mantenimiento", verification_state: "unverified", provenance: "website" },
      { id: "u5", ...T, fact_type: "other", label: "Años de operación (sitio web)", value: "Hechos en Cd. Juárez desde 2015; 10+ años", verification_state: "unverified", provenance: "website" },
    ],
    pages: [{ id: "p1", ...T, url: "https://tlalocsolfuturo.com/", path: "/", title: "Inicio", h1: "Energía solar", indexable: true, status_code: 200, content_text: "Diseñamos sistemas solares. Garantía de por vida." }],
    links: [], issues: [], opportunity: null, keyword: null, cluster: null, clusterKeywords: [], planItem: null, otherArticles: [],
  };
}
const ctx = buildContext(data(), { pageTexts: new Map([["p1", "Diseñamos sistemas solares. Analizamos tu consumo. Garantía de por vida."]]) });
const idx = evidenceIndex(ctx);
const F = (type) => ctx.verified_facts.find((f) => f.type === type).id;
const crawler = ctx.crawler_evidence[0]?.id;
const U = ctx.unverified_data.find((u) => u.type === "warranty").id;
const brandTerms = ["Tlaloc Solfuturo", "tlalocsolfuturo"];

test("business claim supported only by website evidence MUST NOT PASS (even when the model says it is not business-specific)", () => {
  assert.ok(crawler, "fixture has crawler evidence");
  for (const claim of [
    { claim: "Diseñamos sistemas fotovoltaicos.", claim_type: "business", business_specific: true, sensitive_topic: "none" },
    // model tried to declassify: general + business_specific=false, but first person
    { claim: "Realizamos un análisis personalizado antes de proponer un sistema.", claim_type: "general", business_specific: false, sensitive_topic: "none" },
    { claim: "Podemos compartir referencias de instalaciones realizadas en Ciudad Juárez.", claim_type: "general", business_specific: false, sensitive_topic: "none" },
    { claim: "Tlaloc Solfuturo ofrece mantenimiento.", claim_type: "general", business_specific: false, sensitive_topic: "none" },
  ]) {
    for (const status of ["SUPPORTED", "VERIFIED", "NOT_REQUIRED"]) {
      const r = enforceClaim(claim, { verification_status: status, evidence_ids: [crawler, U] }, idx, { brandTerms });
      assert.equal(r.verification_status, "UNVERIFIED", `${claim.claim} / ${status}`);
      assert.equal(r.blocking, true);
      assert.notEqual(r.action, "approve");
    }
  }
  assert.equal(isBusinessClaim({ claim: "Los paneles generan corriente continua.", claim_type: "general" }, { brandTerms }), false);
});

test("verified business_fact may support a MATCHING business claim only", () => {
  const ok = [
    ["Instalamos paneles solares residenciales y comerciales en Ciudad Juárez.", F("service")],
    ["Teléfono de contacto: 656 695 3960.", F("phone")],
    ["Escríbenos a Soporte@solfuturo.com.mx.", F("email")],
    ["Atendemos proyectos en Ciudad Juárez.", F("service_area")],
  ];
  for (const [text, id] of ok) {
    const r = enforceClaim({ claim: text, claim_type: "business", business_specific: true, sensitive_topic: "none" }, { verification_status: "VERIFIED", evidence_ids: [id] }, idx, { brandTerms });
    assert.equal(r.verification_status, "VERIFIED", text);
    assert.equal(r.source, "verified_business_fact");
  }
  // citing a verified fact that does not state the claim is not enough
  const wrongFact = enforceClaim({ claim: "Ofrecemos garantía en la instalación residencial.", claim_type: "business", business_specific: true, sensitive_topic: "warranty" }, { verification_status: "VERIFIED", evidence_ids: [F("service")] }, idx, { brandTerms });
  assert.equal(wrongFact.verification_status, "UNVERIFIED");
  assert.match(wrongFact.notes, /does not specifically support/);
  const wrongPhone = enforceClaim({ claim: "Llámanos al 656 000 1111.", claim_type: "business", business_specific: true, sensitive_topic: "contact" }, { verification_status: "VERIFIED", evidence_ids: [F("phone")] }, idx, { brandTerms });
  assert.equal(wrongPhone.verification_status, "UNVERIFIED");
  assert.equal(factSupportsClaim("Instalación industrial de 2 MW", ctx.verified_facts.find((f) => f.type === "service")), false, "numbers must be in the fact");
});

test("unverified warranty/certification mention is blocked by the post-generation scan (no hints, no rephrasing)", () => {
  const bad = [
    "En la propuesta técnica explicamos las garantías y certificaciones aplicables al proyecto.",
    "Contamos con un equipo certificado.",
    "Pregunta por nuestras opciones de financiamiento.",
    "Tenemos más de 500 instalaciones activas.",
    "Podemos compartir referencias de proyectos realizados.",
    "También realizamos proyectos industriales y mantenimiento.",
    "Trabajamos en Juárez desde 2015.",
  ];
  for (const sentence of bad) {
    const f = scanUnverifiedBusinessMentions(`# Instalación de paneles solares en Ciudad Juárez\n\n${sentence}`, ctx);
    assert.ok(f.length >= 1, sentence);
    assert.equal(f[0].severity, "blocker");
  }
  const clean = [
    "# Instalación de paneles solares en Ciudad Juárez",
    "Instalamos sistemas solares residenciales y comerciales en Ciudad Juárez.",
    "Un sistema fotovoltaico convierte la luz solar en electricidad; el inversor transforma la corriente continua en alterna.",
    "Llámanos al 656 695 3960 o escríbenos a Soporte@solfuturo.com.mx.",
  ].join("\n\n");
  assert.deepEqual(scanUnverifiedBusinessMentions(clean, ctx), []);
});

test("navigation / anchor / button / breadcrumb / UI heading text is not extracted as a claim", () => {
  const md = "# Instalación de paneles solares en Ciudad Juárez\n\n## Preguntas frecuentes\n\nMás información en: [Conócenos — Tlaloc Solfuturo](https://tlalocsolfuturo.com/).\n\n[Solicita tu cotización](https://tlalocsolfuturo.com/#cotizar)";
  for (const text of [
    "Conócenos",
    "Conócenos — Tlaloc Solfuturo",
    "Más información en la página Conócenos — Tlaloc Solfuturo (https://tlalocsolfuturo.com/).",
    "Más información en: [Conócenos — Tlaloc Solfuturo](https://tlalocsolfuturo.com/)",
    "Solicita tu cotización",
    "Inicio > Servicios > Paneles solares",
    "Preguntas frecuentes",
    "https://tlalocsolfuturo.com/",
    "Contacto",
  ]) assert.equal(isNonClaimText(text, md), true, text);
  for (const text of [
    "Instalamos paneles solares residenciales y comerciales en Ciudad Juárez.",
    "Teléfono: 656 695 3960",
    "Solicita tu cotización gratis en menos de 24 horas",
    "Los paneles generan corriente continua.",
  ]) assert.equal(isNonClaimText(text, md), false, text);
});
