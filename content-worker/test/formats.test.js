import { test } from "node:test";
import assert from "node:assert/strict";
import { pickFormat, formatGuide, hypeSentences, POST_FORMATS } from "../src/formats.js";

test("pickFormat: deterministic by topic", () => {
  assert.equal(pickFormat({ primary_keyword: "por qué mi minisplit gotea agua" }), "problem_solution");
  assert.equal(pickFormat({ primary_keyword: "why is my ac not cooling" }), "problem_solution");
  assert.equal(pickFormat({ primary_keyword: "señales de que tu aire necesita servicio" }), "signs_list");
  assert.equal(pickFormat({ primary_keyword: "cuánto cuesta instalar paneles solares" }), "cost_guide");
  assert.equal(pickFormat({ primary_keyword: "how much does brow lamination cost" }), "cost_guide");
  assert.equal(pickFormat({ primary_keyword: "laminado de cejas vs microblading" }), "comparison");
  assert.equal(pickFormat({ primary_keyword: "diferencia entre crédito nuevo y renovación" }), "comparison");
  assert.equal(pickFormat({ primary_keyword: "qué es un sistema interconectado" }), "faq");
  assert.equal(pickFormat({ primary_keyword: "cómo preparar tu casa para el verano" }), "how_to");
  assert.equal(pickFormat({ primary_keyword: "beneficios de la energía solar" }), "aida");
  assert.equal(pickFormat({ primary_keyword: "instalación de paneles", content_type: "service_page" }), "aida_service");
  assert.equal(pickFormat({ primary_keyword: "x", content_type: "faq_page" }), "faq");
});

test("every format has a label and guide; guide never authorizes facts", () => {
  for (const [k, f] of Object.entries(POST_FORMATS)) {
    assert.ok(f.label && f.guide.length > 100, k);
  }
  const g = formatGuide({ primary_keyword: "cuánto cuesta un minisplit" });
  assert.match(g, /HONEST COST GUIDE/);
  assert.match(g, /never allows a business fact/);
  assert.match(formatGuide({ post_format: "comparison", primary_keyword: "zzz" }), /FAIR COMPARISON/);
});

test("hype: removes business-voice superlatives, keeps general advice and verified wording", () => {
  const md = [
    "# Mejor forma de ahorrar luz en Juárez",
    "La mejor forma de ahorrar es revisar tu consumo.",
    "Somos la mejor empresa de paneles en Juárez.",
    "Nuestro servicio está 100% garantizado.",
    "We are the #1 HVAC company in El Paso.",
    "Our team is the best in town.",
    "The best time to service your AC is spring.",
    "Ofrecemos instalación residencial y comercial.",
    "- Somos líderes en energía solar.",
  ].join("\n");
  const out = hypeSentences(md, { verifiedFacts: [], brandTerms: ["Tlaloc"] });
  assert.deepEqual(out, [
    "Somos la mejor empresa de paneles en Juárez.",
    "Nuestro servicio está 100% garantizado.",
    "We are the #1 HVAC company in El Paso.",
    "Our team is the best in town.",
    "Somos líderes en energía solar.",
  ]);
});

test("hype: brand name counts as business voice; verified fact wording is allowed", () => {
  const md = "Tlaloc es el mejor instalador de la ciudad.\nTlaloc ofrece garantía total de 10 años.";
  assert.deepEqual(hypeSentences(md, { brandTerms: ["Tlaloc"] }), ["Tlaloc es el mejor instalador de la ciudad.", "Tlaloc ofrece garantía total de 10 años."]);
  const facts = [{ label: "Garantía", value: "Garantía total de 10 años en paneles" }];
  assert.deepEqual(hypeSentences(md, { brandTerms: ["Tlaloc"], verifiedFacts: facts }), ["Tlaloc es el mejor instalador de la ciudad."]);
  const neg = [{ label: "Garantía", value: "NOT OFFERED: garantía total" }];
  assert.equal(hypeSentences(md, { brandTerms: ["Tlaloc"], verifiedFacts: neg }).length, 2);
});

import { buildContext } from "../src/context.js";
import { scanUnverifiedBusinessMentions } from "../src/checks.js";

const T = { organization: "org1", client: "cliA", website: "webA" };
function reviewData(withReview) {
  return {
    article: { id: "art1", ...T, content_type: "blog_article", primary_keyword: "mantenimiento de minisplit", language: "es", target_location: "", generation_input: {} },
    client: { id: "cliA", organization: "org1", business_name: "Frío A", primary_language: "es" },
    website: { id: "webA", organization: "org1", client: "cliA", domain: "frio-a.mx", primary_language: "es" },
    facts: [
      { id: "f1", ...T, fact_type: "phone", label: "Teléfono", value: "656 695 3960", verified: true, verification_state: "user_confirmed", provenance: "user_provided" },
      ...(withReview ? [{ id: "f2", ...T, fact_type: "other", label: "Reseña de cliente (testimonios)", value: "Llegaron puntuales y dejaron todo limpio.", verified: true, verification_state: "user_confirmed", provenance: "user_provided" }] : []),
    ],
    pages: [{ id: "p1", ...T, url: "https://frio-a.mx/", path: "/", title: "Inicio", h1: "Frío", indexable: true, status_code: 200 }],
    links: [], issues: [], opportunity: null, keyword: null, cluster: null, clusterKeywords: [], planItem: null, otherArticles: [],
  };
}

test("verified customer review: quoting it is not an unverified testimonial", () => {
  const md = "# Mantenimiento de minisplit\n\nNuestros clientes lo dicen: testimonios como \"Llegaron puntuales y dejaron todo limpio.\"";
  const withR = scanUnverifiedBusinessMentions(md, buildContext(reviewData(true)));
  const without = scanUnverifiedBusinessMentions(md, buildContext(reviewData(false)));
  assert.ok(without.length > 0, "testimonial without a verified review must be flagged");
  assert.deepEqual(withR, []);
});

test("a verified NOT OFFERED override never makes its topic verified", () => {
  const d = reviewData(false);
  d.facts.push({ id: "f9", ...T, fact_type: "other", label: "Garantía", value: "NOT OFFERED: Garantía. Never claim it.", verified: true, verification_state: "user_confirmed", provenance: "user_provided" });
  const f = scanUnverifiedBusinessMentions("# Mantenimiento\n\nNuestro trabajo tiene garantía por escrito.", buildContext(d));
  assert.ok(f.some((x) => x.detail === "warranty"), JSON.stringify(f));
});
