// Phase 4 closeout: high-risk flag reflects the CURRENT version; QA issues
// are classified BLOCKER / MAJOR_ADVISORY / MINOR_ADVISORY / NOT_APPLICABLE;
// word count and requests needing unverified evidence never block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext } from "../src/context.js";
import { classifyQaCheck, classifyQaIssue, currentRisk, QA_CLASSIFICATIONS } from "../src/checks.js";

const T = { organization: "o", client: "c", website: "w" };
const ctx = buildContext({
  article: { id: "a", ...T, content_type: "service_page", primary_keyword: "instalación de paneles solares", language: "es", target_location: "Ciudad Juárez", generation_input: {} },
  client: { id: "c", organization: "o", business_name: "Tlaloc Solfuturo", primary_language: "es" },
  website: { id: "w", organization: "o", client: "c", domain: "tlalocsolfuturo.com", primary_language: "es" },
  facts: [
    { id: "f1", ...T, fact_type: "phone", label: "Teléfono", value: "656 695 3960", verified: true, verification_state: "user_confirmed" },
    { id: "f4", ...T, fact_type: "service", label: "Servicios", value: "Instalación solar residencial y comercial", verified: true, verification_state: "user_confirmed" },
    { id: "u1", ...T, fact_type: "warranty", label: "Garantía", value: "Garantía de por vida", verification_state: "unverified" },
  ],
  pages: [{ id: "p1", ...T, url: "https://tlalocsolfuturo.com/", path: "/", title: "Inicio", h1: "Solar", indexable: true, status_code: 200 }],
  links: [], issues: [], opportunity: null, keyword: null, cluster: null, clusterKeywords: [], planItem: null, otherArticles: [],
});
const low = (claim, type = "general", status = "NOT_REQUIRED") => ({ claim, claim_type: type, verification_status: status, risk_level: "low" });

test("high-risk flag reflects CURRENT claims/copy: all-low v10 clears it; a current high-risk claim sets it", () => {
  const v10 = "# Instalación de paneles solares en Ciudad Juárez\n\nInstalamos sistemas solares residenciales y comerciales en Ciudad Juárez. Llámanos al 656 695 3960.\n\nLos paneles convierten la luz del sol en electricidad; el inversor la transforma en corriente alterna.";
  const claims = [low("Instalamos sistemas solares…", "business", "VERIFIED"), low("Los paneles convierten la luz…", "product"), low("El inversor…", "product")];
  const r = currentRisk(v10, claims);
  assert.equal(r.high_risk, false);
  assert.deepEqual(r.categories, []);
  assert.equal(r.high_risk_claims, 0);
  // research-stage topic categories (legal/financial/regulated) no longer leak into the current flag
  const withHigh = [...claims, { claim: "Existen incentivos fiscales", claim_type: "financial", verification_status: "UNVERIFIED", risk_level: "high" }];
  assert.equal(currentRisk(v10, withHigh).high_risk, true);
  assert.equal(currentRisk(`${v10}\n\nOfrecemos financiamiento sin intereses.`, claims).high_risk, true, "risky copy still flags");
});

test("QA advisory calibration: requests needing unverified evidence are NOT_APPLICABLE", () => {
  for (const description of [
    "Faltan secciones clave: Opciones de pago y garantías.",
    "Agrega información de financiamiento para aumentar conversiones.",
    "Añade el proceso de gestión con CFE y medidor bidireccional.",
    "Incluye casos ilustrativos o casos de éxito en Ciudad Juárez.",
    "Enlaza a la sección 'Sobre SolFuturo / Proyectos en Cd. Juárez'.",
    "Menciona certificaciones del equipo.",
    "Agrega tiempos estimados de instalación.",
  ]) {
    for (const severity of ["blocker", "major"]) {
      assert.equal(classifyQaIssue({ severity, check: "structure", description, origin: "reviewer" }, ctx), "NOT_APPLICABLE", description);
    }
  }
});

test("word count is advisory, never a blocker", () => {
  const issue = { severity: "blocker", check: "usefulness", description: "La página es demasiado corta (263 palabras) y no alcanza el mínimo de 700 palabras.", origin: "reviewer" };
  assert.equal(classifyQaIssue(issue, ctx), "MINOR_ADVISORY");
  assert.equal(classifyQaCheck({ check: "usefulness", status: "fail", details: "Contenido demasiado breve (263 palabras) y no cumple el rango recomendado (700–1200)." }, ctx), "MINOR_ADVISORY");
});

test("factual problems stay BLOCKER; editorial reviewer findings are advisories; deterministic keep severity", () => {
  assert.equal(classifyQaIssue({ severity: "blocker", check: "unsupported_claims", description: "UNVERIFIED business claim", origin: "reviewer" }, ctx), "BLOCKER");
  assert.equal(classifyQaIssue({ severity: "blocker", check: "hallucination_risk", description: "invented quote", origin: "reviewer" }, ctx), "BLOCKER");
  assert.equal(classifyQaIssue({ severity: "blocker", check: "cta", description: "La CTA es débil", origin: "reviewer" }, ctx), "MAJOR_ADVISORY");
  assert.equal(classifyQaIssue({ severity: "minor", check: "readability", description: "Frases largas", origin: "reviewer" }, ctx), "MINOR_ADVISORY");
  assert.equal(classifyQaIssue({ severity: "blocker", check: "unsupported_claims", description: "UNVERIFIED_BUSINESS_TOPIC (warranty): …", origin: "deterministic" }, ctx), "BLOCKER");
  assert.equal(classifyQaIssue({ severity: "minor", check: "repetition", description: "Repeated sentence (2×)", origin: "deterministic" }, ctx), "MINOR_ADVISORY");
  assert.equal(classifyQaCheck({ check: "factual_consistency", status: "fail", details: "contradiction" }, ctx), "BLOCKER");
  assert.equal(classifyQaCheck({ check: "factual_consistency", status: "pass", details: "" }, ctx), "PASS");
  assert.deepEqual(QA_CLASSIFICATIONS, ["BLOCKER", "MAJOR_ADVISORY", "MINOR_ADVISORY", "NOT_APPLICABLE"]);
});
