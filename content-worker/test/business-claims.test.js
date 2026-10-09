// Phase 4 fix round 2: business claims need a matching verified fact (website
// evidence never suffices, model cannot declassify), strict omission of
// unverified business facts, navigation/UI text is not a claim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext, evidenceIndex } from "../src/context.js";
import { scrubSentences, localDifferentiation, enforceClaim, factSupportsClaim, isBusinessClaim, isNonClaimText, isOwnSitePointer, scanUnverifiedBusinessMentions } from "../src/checks.js";

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

test("impersonal educational sentences are not business claims just because the AI labelled them", () => {
  const generic = enforceClaim({ claim: "Una cotización típica suele incluir el dimensionamiento estimado del sistema.", claim_type: "business", business_specific: true, sensitive_topic: "none" }, { verification_status: "UNVERIFIED", evidence_ids: [] }, idx, { brandTerms });
  assert.notEqual(generic.risk_level, "high");
  const warranty = enforceClaim({ claim: "La instalación incluye garantía de por vida.", claim_type: "business", business_specific: true, sensitive_topic: "warranty" }, { verification_status: "UNVERIFIED", evidence_ids: [] }, idx, { brandTerms });
  assert.equal(warranty.risk_level, "high");
  const firstPerson = enforceClaim({ claim: "Instalamos en menos de una semana.", claim_type: "other", sensitive_topic: "none" }, { verification_status: "UNVERIFIED", evidence_ids: [] }, idx, { brandTerms });
  assert.equal(firstPerson.risk_level, "high");
});

test("impersonal educational claim on a sensitive topic does not block; numbers still block", () => {
  const ev = new Map();
  const soft = enforceClaim({ claim: "Technicians check refrigerant pressures and look for leaks.", claim_type: "general", business_specific: false, sensitive_topic: "safety" }, { verification_status: "UNVERIFIED", evidence_ids: [] }, ev);
  assert.equal(soft.verification_status, "NOT_REQUIRED");
  assert.equal(soft.blocking, false);
  const legal = enforceClaim({ claim: "La distribuidora define los requisitos de interconexión.", claim_type: "legal", business_specific: false, sensitive_topic: "legal" }, { verification_status: "UNVERIFIED", evidence_ids: [] }, ev);
  assert.equal(legal.verification_status, "UNVERIFIED");
  assert.equal(legal.blocking, false);
  const hard = enforceClaim({ claim: "Systems pay back in 5 years.", claim_type: "financial", business_specific: false, sensitive_topic: "financing" }, { verification_status: "UNVERIFIED", evidence_ids: [] }, ev);
  assert.equal(hard.blocking, true);
});

test("links to the business's own site, formatted phones and uncited verified services are verified", () => {
  const own = { brandTerms, ownDomain: "tlalocsolfuturo.com" };
  for (const text of ["Sitio web de Tlaloc Solfuturo: https://tlalocsolfuturo.com/.", "Tenemos un blog en https://www.tlalocsolfuturo.com/blog.", "Visita https://tlalocsolfuturo.com/about para conocernos."]) {
    const r = enforceClaim({ claim: text, claim_type: "business", business_specific: true, sensitive_topic: "none" }, { verification_status: "UNVERIFIED", evidence_ids: [] }, idx, own);
    assert.equal(r.verification_status, "VERIFIED", text);
    assert.equal(r.blocking, false);
  }
  assert.equal(isOwnSitePointer("Garantía de por vida: https://tlalocsolfuturo.com/garantia", "tlalocsolfuturo.com"), false);
  assert.equal(isOwnSitePointer("Mira https://otro.com/", "tlalocsolfuturo.com"), false);
  assert.equal(isOwnSitePointer("Más de 500 proyectos en https://tlalocsolfuturo.com/", "tlalocsolfuturo.com"), false);
  const phone = enforceClaim({ claim: "Llámanos al +52 (656) 695-3960.", claim_type: "business", business_specific: true, sensitive_topic: "contact" }, { verification_status: "UNVERIFIED", evidence_ids: [] }, idx, own);
  assert.equal(phone.verification_status, "VERIFIED");
  const svc = enforceClaim({ claim: "Tlaloc Solfuturo realiza la instalación solar residencial en Ciudad Juárez.", claim_type: "business", business_specific: true, sensitive_topic: "none" }, { verification_status: "UNVERIFIED", evidence_ids: [] }, idx, own);
  assert.equal(svc.verification_status, "VERIFIED");
  const maint = enforceClaim({ claim: "Tlaloc Solfuturo ofrece mantenimiento.", claim_type: "business", business_specific: true, sensitive_topic: "none" }, { verification_status: "UNVERIFIED", evidence_ids: [] }, idx, own);
  assert.equal(maint.blocking, true);
});

test("fact checker citing the DB record id still verifies; uncited exact verified facts match", () => {
  const own = { brandTerms, ownDomain: "tlalocsolfuturo.com" };
  const r = enforceClaim({ claim: "Instalamos sistemas solares residenciales y comerciales.", claim_type: "business", business_specific: true, sensitive_topic: "none" }, { verification_status: "VERIFIED", evidence_ids: ["f4"] }, idx, own);
  assert.equal(r.verification_status, "VERIFIED");
  assert.doesNotMatch(r.notes, /unknown evidence/);
  const promise = enforceClaim({ claim: "Instalamos sistemas solares residenciales en menos de 24 horas.", claim_type: "business", business_specific: true, sensitive_topic: "none" }, { verification_status: "UNVERIFIED", evidence_ids: [] }, idx, own);
  assert.equal(promise.blocking, true);
});

test("local evidence matches the city even when facts omit the state", () => {
  const c = { meta: { content_type: "location_page", target_location: "Ciudad Juárez, Chihuahua" }, verified_facts: ctx.verified_facts, crawler_evidence: [{ id: "C1", title: "Inicio", h1: "Solar", text: "Instalaciones en Ciudad Juárez" }], external_sources: [], other_articles: [] };
  const r = localDifferentiation("# x", c);
  assert.ok(r.local_evidence.length >= 2, JSON.stringify(r));
});

test("Modo Soro: unconfirmed sentences are deleted instead of blocking the post", () => {
  const md = "# Paneles solares en Juárez\n\n## Garantías y financiamiento\n\nInstalamos sistemas residenciales. Ofrecemos garantía de por vida en la instalación. Llámanos al 656 695 3960.\n\n- Tenemos más de 500 instalaciones activas.\n- Revisamos tu recibo de CFE.";
  const r = scrubSentences(md, ["Ofrecemos garantía de por vida en la instalación.", "Tenemos más de 500 instalaciones activas.", "Garantías y financiamiento"]);
  assert.equal(r.removed.length, 3);
  assert.match(r.markdown, /^# Paneles solares en Juárez/);
  assert.match(r.markdown, /Instalamos sistemas residenciales\. Llámanos al 656 695 3960\./);
  assert.doesNotMatch(r.markdown, /garantía|500/i);
  assert.match(r.markdown, /Revisamos tu recibo de CFE/);
  assert.equal(scrubSentences("# T\n\nNada que quitar.", ["frase inexistente totalmente distinta"]).removed.length, 0);
});

test("Modo Soro: a list item the flagged claim paraphrases is removed too", () => {
  const md = "# Paneles\n\nTe pedimos:\n\n- Consumos estimados futuros si esperas cambios (nuevos equipos, ampliaciones, etc.).\n- Dirección del inmueble.";
  const r = scrubSentences(md, ["Para preparar una propuesta normalmente se solicita consumos estimados futuros si se esperan cambios (nuevos equipos, ampliaciones, etc.)."]);
  assert.equal(r.removed.length, 1);
  assert.match(r.markdown, /Dirección del inmueble/);
});
