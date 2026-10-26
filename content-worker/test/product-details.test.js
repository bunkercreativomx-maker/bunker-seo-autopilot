// Product-detail grounding: a business sentence may restate or MIX what the
// verified facts / the client's own website say, never add details.
import test from "node:test";
import assert from "node:assert/strict";
import { enforceClaim, contradictingFact, sitePageSupports } from "../src/checks.js";

const facts = [
  { id: "F1", type: "email", label: "Email", value: "soporte@donpunto.com" },
  { id: "F2", type: "service", label: "Service", value: "Corte de caja: efectivo, tarjeta y ventas de apps de comida a domicilio por separado" },
  { id: "F3", type: "service", label: "Service", value: "IVA separado en cada venta (16% o 8% zona fronteriza)" },
  { id: "F4", type: "service", label: "Service", value: "Reportes avanzados: horas pico, mejores días, platillos estrella; Excel o PDF" },
  { id: "F5", type: "service", label: "Service", value: "Facturas de proveedor leídas con IA que capturan compras al inventario" },
  { id: "F6", type: "service", label: "Service", value: "soporte técnico" },
  { id: "F7", type: "other", label: "Not offered", value: "NOT OFFERED: Don Punto NO está integrado con ninguna app de comida a domicilio. No recibe pedidos de esas apps." },
];
const page = { id: "C1", url: "https://donpunto.com/", title: "Don Punto", h1: "Punto de venta para restaurantes", headings: [], text: "Imprime tickets en cualquier impresora instalada de 58 mm o carta. Menú desde una foto con IA." };
const evidence = new Map([...facts.map((f) => [f.id, { category: "verified_fact", item: f }]), ["C1", { category: "crawler", item: page }]]);
const opts = { brandTerms: ["Don Punto", "donpunto"], ownDomain: "donpunto.com" };
const claim = (text) => ({ claim: text, claim_type: "product", business_specific: true, sensitive_topic: "none" });
const run = (text, details) => enforceClaim(claim(text), { verification_status: "VERIFIED", evidence_ids: [], details }, evidence, opts);

test("invented product details fail even when the checker says VERIFIED", () => {
  const r = run("Don Punto lee facturas de proveedor con IA y luego exporta la relación de compras.", [
    { detail: "lee facturas de proveedor con IA", fact_ids: ["F5"] },
    { detail: "exporta la relación de compras", fact_ids: ["F5"] },
  ]);
  assert.equal(r.verification_status, "UNVERIFIED");
  assert.match(r.notes, /exporta la relación de compras/);
  const offer = run("Don Punto te ayuda a generar los archivos que tu contador necesite.", [{ detail: "ayuda a generar los archivos para el contador", fact_ids: ["F6"] }]);
  assert.equal(offer.verification_status, "UNVERIFIED");
  // no details from the checker -> strict whole-sentence coverage
  const noDetails = run("Don Punto genera 6 archivos para tu contador con conciliación bancaria.", []);
  assert.equal(noDetails.verification_status, "UNVERIFIED");
});

test("a sentence may MIX several verified facts", () => {
  const r = run("Don Punto tiene reportes, IVA separado por venta y cortes de caja por medio de pago.", [
    { detail: "reportes avanzados", fact_ids: ["F4"] },
    { detail: "IVA separado por venta", fact_ids: ["F3"] },
    { detail: "cortes de caja por efectivo, tarjeta y apps", fact_ids: ["F2"] },
  ]);
  assert.equal(r.verification_status, "VERIFIED");
});

test("the client's own website backs plain offer descriptions, not numbers or warranties", () => {
  assert.equal(run("Con Don Punto imprimes tickets en cualquier impresora instalada.", [{ detail: "imprime tickets en cualquier impresora instalada", fact_ids: ["C1"] }]).verification_status, "VERIFIED");
  assert.equal(sitePageSupports("imprime en impresora de 58 mm", [page]), false, "numbers need F*");
  assert.equal(sitePageSupports("garantía de por vida en la impresora", [page]), false, "warranties need F*");
  assert.equal(run("Don Punto incluye cajón de dinero y lector de código de barras.", [{ detail: "cajón de dinero y lector de código de barras", fact_ids: ["C1"] }]).verification_status, "UNVERIFIED");
});

test("a NOT OFFERED fact contradicts the claim and never supports it", () => {
  assert.ok(contradictingFact("Don Punto recibe pedidos de las apps de comida a domicilio integradas.", facts, opts));
  const r = run("Don Punto recibe pedidos de las apps de comida a domicilio integradas.", [{ detail: "recibe pedidos de apps de comida a domicilio", fact_ids: ["F7"] }]);
  assert.equal(r.verification_status, "CONTRADICTED");
  assert.equal(r.blocking, true);
  // naming the product next to the override is not a contradiction
  assert.equal(contradictingFact("Don Punto es un punto de venta en la nube para restaurantes.", facts, opts), null);
});
