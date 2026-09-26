import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProfile, detectSiteLanguage, findQuote, normalizeText, valueSupported, deterministicFacts } from "../src/profile.js";

const ES_TEXT = "Somos una empresa de Ciudad Juárez dedicada a la instalación de paneles solares para el hogar y los comercios. Ofrecemos financiamiento sin intereses y garantía de 25 años en paneles. Contáctanos para una cotización sin costo, con servicio en todo Chihuahua.";
const EN_TEXT = "We are a family owned HVAC company in El Paso. We install and repair air conditioners and heaters for your home and your business. Call us today for a free estimate, and ask about our 10 year warranty on new systems.";

const page = (url, text, extra = {}) => ({ url, path: new URL(url).pathname, status_code: 200, isHtml: true, title: "", meta_description: "", text_excerpt: text, language: "en", ...extra });

test("language comes from the visible text, not the template's <html lang>", () => {
  const r = detectSiteLanguage([page("https://a.mx/", ES_TEXT, { language: "en" }), page("https://a.mx/servicios", ES_TEXT, { language: "en" })]);
  assert.equal(r.language, "es");
  assert.equal(r.source, "text");
  assert.equal(detectSiteLanguage([page("https://b.com/", EN_TEXT, { language: "es" })]).language, "en");
});

test("quotes must exist word-for-word on the site; values must match their quote", () => {
  const texts = [{ url: "https://a.mx/", norm: normalizeText(ES_TEXT) }];
  assert.equal(findQuote("financiamiento sin intereses", texts), "https://a.mx/");
  assert.equal(findQuote("Financiamiento  SIN intereses", texts), "https://a.mx/");
  assert.equal(findQuote("financiamiento a 0% de enganche", texts), null);
  assert.equal(valueSupported("Garantía de 25 años", "garantía de 25 años en paneles"), true);
  assert.equal(valueSupported("Garantía de por vida", "garantía de 25 años en paneles"), false);
});

test("tel: and mailto: links become phone/email facts", () => {
  const f = deterministicFacts([page("https://a.mx/", ES_TEXT, { phones: ["+526566953960"], emails: ["hola@a.mx"] })]);
  assert.deepEqual(f.map((x) => x.fact_type).sort(), ["email", "phone"]);
});

test("AI facts without a real quote are dropped; grounded ones are kept (in the site's language)", async () => {
  const ai = {
    apiKey: "test", baseUrl: "http://fake", model: "m",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          business_name: { value: "Tlaloc SolFuturo", quote: "" },
          industry: "Energía solar", description: "Instalación de paneles solares en Ciudad Juárez.", country: "MX",
          primary_location: { value: "Ciudad Juárez", quote: "empresa de Ciudad Juárez" },
          service_areas: [{ value: "Chihuahua", quote: "servicio en todo Chihuahua" }],
          services: [
            { value: "Instalación de paneles solares", quote: "instalación de paneles solares para el hogar" },
            { value: "Baterías de litio", quote: "baterías de litio de alta capacidad" },
          ],
          products: [],
          facts: [
            { type: "financing", label: "Financiamiento", value: "Financiamiento sin intereses", quote: "Ofrecemos financiamiento sin intereses" },
            { type: "warranty", label: "Garantía", value: "Garantía de por vida", quote: "garantía de por vida" },
          ],
          target_audience: "Hogares y comercios", primary_cta: "Cotización sin costo", brand_voice: "Cercano",
        }),
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    }),
  };
  const r = await buildProfile([page("https://a.mx/", ES_TEXT, { language: "en" })], ai);
  assert.equal(r.language.language, "es");
  assert.equal(r.client.primary_language, "es");
  const vals = r.facts.map((f) => `${f.fact_type}:${f.value}`);
  assert.ok(vals.includes("service:Instalación de paneles solares"));
  assert.ok(vals.includes("financing:Financiamiento sin intereses"));
  assert.ok(vals.includes("location:Ciudad Juárez"));
  assert.ok(!vals.some((v) => v.includes("litio")), "invented service must be dropped");
  assert.ok(!vals.some((v) => v.includes("por vida")), "invented warranty must be dropped");
  assert.equal(r.dropped, 2);
  assert.equal(r.client.country, "MX");
  assert.ok(r.facts.every((f) => f.source_url === "https://a.mx/"));
});

test("works without AI (deterministic only)", async () => {
  const r = await buildProfile([page("https://b.com/", EN_TEXT, { phones: ["+19155551234"], og: { site_name: "Cool Air" } })], null);
  assert.equal(r.language.language, "en");
  assert.equal(r.client.business_name, "Cool Air");
  assert.equal(r.client.phone, "+19155551234");
  assert.equal(r.client.country, "US");
  assert.equal(r.ai_used, false);
});
