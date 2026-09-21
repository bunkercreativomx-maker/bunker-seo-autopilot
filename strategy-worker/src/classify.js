import { normalizeKeyword } from "./normalize.js";

const TRANSACTIONAL = ["buy", "order", "book", "hire", "price", "pricing", "quote", "near me", "comprar", "precio", "cotizar", "contratar", "reservar"];
const COMMERCIAL = ["best", "top", "review", "compare", "versus", "cost", "mejor", "reseña", "comparar", "costo"];
const INFORMATIONAL = ["how", "what", "why", "guide", "tips", "learn", "como", "qué", "que", "por qué", "guía", "guia", "consejos"];

export function classifyIntent(keyword) {
  const value = normalizeKeyword(keyword);
  if (TRANSACTIONAL.some((cue) => value.includes(normalizeKeyword(cue)))) return "transactional";
  if (COMMERCIAL.some((cue) => value.includes(normalizeKeyword(cue)))) return "commercial";
  if (INFORMATIONAL.some((cue) => value.includes(normalizeKeyword(cue)))) return "informational";
  return "navigational";
}

export function inferPageType(keyword, source = {}) {
  const value = normalizeKeyword(keyword);
  const path = normalizeKeyword(source.path || source.url || "");
  if (/\b(blog|article|guide|news|post|guia)\b/.test(path) || classifyIntent(value) === "informational") return "article";
  if (/\b(product|shop|store|producto|tienda)\b/.test(path)) return "product";
  if (/\b(location|locations|city|ubicacion|sucursal)\b/.test(path)) return "location";
  if (/\b(about|contact|nosotros|contacto)\b/.test(path)) return "utility";
  return "service";
}
