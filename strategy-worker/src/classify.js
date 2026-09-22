import { normalizeKeyword, tokenize } from "./normalize.js";

// Cues are matched against the normalized phrase. "transactional" = the searcher
// wants to buy/hire now, "commercial" = comparing providers or evaluating an
// offering, "informational" = learning, "navigational" = looking for a brand.
const TRANSACTIONAL = ["buy", "order", "book", "hire", "quote", "near me", "price", "pricing", "precio", "comprar", "cotizar", "contratar", "reservar", "contactar"];
const COMMERCIAL = ["best", "top", "review", "compare", "versus", "cost", "mejor", "reseña", "comparar", "costo", "presupuesto"];
const INFORMATIONAL = ["how", "what", "why", "guide", "tips", "learn", "como", "qué", "que", "por qué", "guía", "guia", "consejos", "beneficios", "ventajas", "funciona"];
// Terms that signal "I need this service performed" rather than "tell me about it".
const SERVICE_SEEKING = [
  "installation", "install", "instalacion", "repair", "reparacion", "service", "servicio", "servicios",
  "maintenance", "mantenimiento", "financing", "financiamiento", "financiacion", "systems", "system",
  "sistemas", "sistema", "panels", "panel", "paneles", "company", "empresa", "contractor", "proveedor",
  "replacement", "reemplazo", "cleaning", "limpieza", "inspection", "inspeccion",
];
const LOCAL_CUES = ["near me", "cerca de mi", "cerca de mí", "en mi ciudad", "local", "en mi zona"];
// Words that, combined with a brand, still mean "find the brand's site" rather
// than a distinct intent (e.g. "Tlaloc Sol Futuro website").
const NAVIGATIONAL_CUES = ["website", "web", "site", "official", "oficial", "login", "portal", "inicio", "pagina", "página", "homepage"];

function contains(haystack, needle) {
  const value = normalizeKeyword(needle);
  return value.length >= 3 && haystack.includes(value);
}

/**
 * Intent classification is deterministic and evidence-based.
 * `context` may supply the declared locations, the business/brand name and
 * whether the phrase came from a declared service or product.
 *
 * Branded queries are NOT all forced to navigational:
 *   - brand alone (or brand + navigation words)          -> navigational
 *   - brand + a served location                          -> local
 *   - brand + a declared service/product                 -> mixed (meaningful mixed intent)
 *   - brand + a strong transactional/commercial cue      -> that intent
 */
export function classifyIntent(keyword, context = {}) {
  const value = normalizeKeyword(keyword);
  if (!value) return "mixed";
  const locations = (context.locations || []).map(normalizeKeyword).filter((item) => item.length >= 3);
  const brand = normalizeKeyword(context.brand || "");
  const onSite = locations.some((location) => value.includes(location));
  const local = onSite || LOCAL_CUES.some((cue) => contains(value, cue));
  const branded = Boolean(brand) && contains(value, brand);
  const transactional = TRANSACTIONAL.some((cue) => contains(value, cue));
  const commercial = COMMERCIAL.some((cue) => contains(value, cue));
  const informational = INFORMATIONAL.some((cue) => contains(value, cue));
  const serviceSeeking = SERVICE_SEEKING.some((cue) => contains(value, cue));

  if (branded) {
    // A brand query that also names a served location is still a local query.
    if (local) return "local";
    const brandTokens = tokenize(brand);
    const extraTokens = [...tokenize(value)].filter((token) => !brandTokens.has(token));
    const purelyNavigational = extraTokens.length === 0 || extraTokens.every((token) => NAVIGATIONAL_CUES.includes(token));
    if (purelyNavigational) return "navigational";
    // Brand + a strong single intent keeps that intent.
    if (transactional) return "transactional";
    if (commercial) return "commercial";
    if (informational) return "informational";
    // Brand + a declared service/product has meaningful mixed intent.
    if (context.isService || serviceSeeking) return "mixed";
    return "mixed";
  }

  if (transactional) return "transactional";
  if (commercial) return "commercial";
  if (informational) return "informational";
  if (local) return "local";
  // No linguistic cue but it names an offered service/product: commercially relevant.
  if (context.isService || serviceSeeking) return "commercial";
  return "mixed";
}

export function inferPageType(keyword, source = {}, context = {}) {
  const value = normalizeKeyword(keyword);
  const path = normalizeKeyword(source.path || source.url || "");
  const intent = classifyIntent(keyword, context);
  if (/\b(blog|article|guide|news|post|guia)\b/.test(path) || intent === "informational") return "article";
  if (/\b(product|shop|store|producto|tienda)\b/.test(path)) return "product";
  if (/\b(location|locations|city|ubicacion|sucursal)\b/.test(path)) return "location";
  if (/\b(about|contact|nosotros|contacto)\b/.test(path)) return "utility";
  // A phrase that pairs a declared service with a declared location is a local
  // landing opportunity, not a generic service page.
  const locations = (context.locations || []).map(normalizeKeyword).filter((item) => item.length >= 3);
  if (intent === "local" && locations.some((location) => value.includes(location))) return "location";
  return "service";
}
