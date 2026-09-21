import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntent, inferPageType } from "../src/classify.js";

const context = { locations: ["Ciudad Juarez", "El Paso"], brand: "Tlaloc Sol Futuro", isService: true };

test("a declared location makes the keyword a local query", () => {
  assert.equal(classifyIntent("Commercial solar energy systems ciudad juarez", context), "local");
  assert.equal(classifyIntent("paneles solares ciudad juarez", context), "local");
  assert.equal(classifyIntent("hvac repair near me"), "transactional");
});

test("brand-only queries stay navigational", () => {
  assert.equal(classifyIntent("Tlaloc Sol Futuro paneles solares", context), "navigational");
});

test("a branded query that names a served location is still local", () => {
  assert.equal(classifyIntent("Tlaloc Sol Futuro paneles solares ciudad juarez", context), "local");
});

test("declared services without a location are commercially relevant, not navigational", () => {
  assert.equal(classifyIntent("Commercial solar energy systems", context), "commercial");
  assert.equal(classifyIntent("Solar panel installation", context), "commercial");
});

test("transactional, commercial and informational cues keep working in both languages", () => {
  assert.equal(classifyIntent("precio implantes dentales"), "transactional");
  assert.equal(classifyIntent("comprar paneles solares"), "transactional");
  assert.equal(classifyIntent("mejor sistema solar"), "commercial");
  assert.equal(classifyIntent("how dental implants work"), "informational");
  assert.equal(classifyIntent("beneficios de la energia solar"), "informational");
});

test("a phrase with no cue and no declared service is mixed rather than falsely navigational", () => {
  assert.equal(classifyIntent("zzz qqq", {}), "mixed");
});

test("service plus declared location maps to a location page, a generic service to a service page", () => {
  assert.equal(inferPageType("paneles solares ciudad juarez", {}, context), "location");
  assert.equal(inferPageType("Commercial solar energy systems", {}, context), "service");
  assert.equal(inferPageType("how solar works", {}, context), "article");
});