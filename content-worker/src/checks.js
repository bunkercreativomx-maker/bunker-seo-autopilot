// Deterministic guards that do not depend on any model's honesty:
// claim verification enforcement, duplicate + local-differentiation checks,
// high-risk detection, internal-link validation, metadata and structured data.
import {
  detectLanguage, headingsFromMarkdown, languageBase, linksFromMarkdown, markdownToText,
  normalizeForMatch, shingles, similarity, slugify, tokens, wordCount,
} from "./text.js";

// ---------------------------------------------------------------------------
// Claims

const SENSITIVE_BUSINESS = new Set(["price", "financing", "warranty", "certification", "guarantee", "promotion", "credential", "contact", "availability"]);
const HIGH_RISK_TYPES = new Set(["statistic", "medical", "financial", "legal"]);

/**
 * Enforce claim verification rules over the fact checker's proposal.
 * The fact checker can only ever DOWNGRADE trust; it cannot mark a business
 * claim VERIFIED without a verified business fact, nor cite unknown evidence.
 */
export function enforceClaim(claim, proposal, evidence) {
  const known = (proposal?.evidence_ids || []).filter((id) => evidence.has(id));
  const invalidRefs = (proposal?.evidence_ids || []).filter((id) => !evidence.has(id));
  const categories = new Set(known.map((id) => evidence.get(id).category));
  const business = Boolean(claim.business_specific) || claim.claim_type === "business" || claim.claim_type === "product";
  const sensitive = SENSITIVE_BUSINESS.has(claim.sensitive_topic);
  const highRiskTopic = HIGH_RISK_TYPES.has(claim.claim_type) || ["statistic", "medical", "legal", "safety", "financing"].includes(claim.sensitive_topic);
  const contradicted = proposal?.verification_status === "CONTRADICTED";
  const notes = [proposal?.notes || ""];
  if (invalidRefs.length) notes.push(`Ignored unknown evidence ids: ${invalidRefs.join(", ")}`);

  let status;
  let risk;
  let source = "";
  let sourceId = "";
  if (contradicted) {
    status = "CONTRADICTED";
    risk = "high";
  } else if (proposal?.verification_status === "NOT_REQUIRED" && isStableGeneralKnowledge(claim)) {
    // Stable, textbook technical/general knowledge (e.g. "panels produce DC",
    // "an inverter converts DC to AC"). The code gate never allows it for
    // business-specific, statistical, financial, legal, medical or sensitive
    // claims, nor for anything containing numbers.
    status = "NOT_REQUIRED";
    risk = "low";
  } else if (business) {
    if (categories.has("verified_fact")) {
      status = "VERIFIED";
      risk = "low";
      sourceId = known.find((id) => evidence.get(id).category === "verified_fact");
      source = "verified_business_fact";
    } else if ((categories.has("crawler") || categories.has("unverified")) && !sensitive) {
      status = "SUPPORTED";
      risk = "medium";
      sourceId = known.find((id) => ["crawler", "unverified"].includes(evidence.get(id).category));
      source = evidence.get(sourceId).category === "crawler" ? "client_website" : "client_declared";
    } else {
      status = "UNVERIFIED";
      risk = "high";
      if (sensitive && (categories.has("crawler") || categories.has("unverified"))) notes.push("Sensitive business claim needs a VERIFIED business fact; client website/profile is not sufficient.");
    }
  } else if (categories.has("external")) {
    status = "SUPPORTED";
    risk = highRiskTopic ? "medium" : "low";
    sourceId = known.find((id) => evidence.get(id).category === "external");
    source = "research_source";
  } else {
    status = "UNVERIFIED";
    risk = highRiskTopic ? "high" : "medium";
  }
  const blocking = status === "CONTRADICTED" || (status === "UNVERIFIED" && risk === "high");
  let action = proposal?.action || "approve";
  if (blocking && action === "approve") action = "rewrite";
  if (!blocking && status !== "UNVERIFIED" && action === "flag") action = "approve";
  const evidenceIds = known.filter((id) => evidence.get(id).category !== "ai_inference");
  return {
    claim: String(claim.claim || "").slice(0, 2000),
    claim_type: claim.claim_type,
    sensitive_topic: claim.sensitive_topic || "none",
    verification_status: status,
    risk_level: risk,
    evidence_ids: evidenceIds,
    source,
    source_id: sourceId || "",
    action,
    blocking,
    suggested_rewrite: proposal?.suggested_rewrite || "",
    notes: notes.filter(Boolean).join(" ").slice(0, 2000),
  };
}

const STABLE_KNOWLEDGE_TYPES = new Set(["general", "product", "external"]);
const VOLATILE_TOPICS = new Set(["price", "financing", "warranty", "certification", "guarantee", "promotion", "availability", "contact", "credential", "statistic", "medical", "legal"]);

/** Deterministic gate for NOT_REQUIRED: the model may propose it, code decides whether it is allowed. */
export function isStableGeneralKnowledge(claim) {
  if (!claim || claim.business_specific) return false;
  if (!STABLE_KNOWLEDGE_TYPES.has(claim.claim_type)) return false;
  if (VOLATILE_TOPICS.has(claim.sensitive_topic || "none")) return false;
  if (/\d/.test(String(claim.claim || ""))) return false; // numbers/years/percentages always need a source
  return true;
}

export function summarizeClaims(claims) {
  const blocking = claims.filter((c) => c.blocking);
  const unverified = claims.filter((c) => c.verification_status === "UNVERIFIED");
  const status = blocking.length ? "blocked" : unverified.length ? "issues" : "passed";
  return { status, blocking: blocking.length, unverified: unverified.length, total: claims.length };
}

// ---------------------------------------------------------------------------
// Deterministic content scans (backstops independent of model output)

const PHONE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g;
const PRICE = /(?:\$\s?\d[\d,.]*|\d[\d,.]*\s?(?:MXN|USD|pesos|dólares|dolares|dollars))/gi;
const PERCENT = /\b\d{1,3}(?:[.,]\d+)?\s?%/g;
const QUOTE_ATTRIBUTION = /[“"][^”"]{20,}[”"]\s*[—–-]\s*[A-ZÁÉÍÓÚÑ][\p{L}.]+/gu;

function digits(value) { return String(value).replace(/\D/g, ""); }

export function scanUnsupportedSpecifics(markdown, context) {
  const text = markdownToText(markdown);
  const verifiedText = context.verified_facts.map((f) => `${f.label} ${f.value}`).join(" \n ");
  const verifiedDigits = digits(verifiedText);
  const evidenceText = [
    verifiedText,
    ...context.external_sources.map((s) => s.excerpt),
  ].join(" \n ");
  const findings = [];
  for (const match of text.matchAll(PHONE)) {
    const d = digits(match[0]);
    if (d.length < 8) continue;
    if (!verifiedDigits.includes(d.slice(-8))) findings.push({ code: "UNVERIFIED_PHONE", severity: "blocker", value: match[0].trim() });
  }
  for (const match of text.matchAll(PRICE)) {
    const d = digits(match[0]);
    if (!d || !verifiedDigits.includes(d)) findings.push({ code: "UNSUPPORTED_PRICE", severity: "blocker", value: match[0].trim() });
  }
  const evidenceNorm = normalizeForMatch(evidenceText);
  for (const match of text.matchAll(PERCENT)) {
    const n = match[0].replace(/\s/g, "").replace("%", "");
    if (!evidenceNorm.includes(`${n}%`) && !evidenceNorm.includes(`${n} %`) && !evidenceNorm.includes(n.replace(".", ","))) {
      findings.push({ code: "UNSOURCED_STATISTIC", severity: "major", value: match[0].trim() });
    }
  }
  for (const match of text.matchAll(QUOTE_ATTRIBUTION)) findings.push({ code: "POSSIBLE_FAKE_QUOTE", severity: "major", value: match[0].slice(0, 120) });
  return findings;
}

// Editorial/meta language that must never appear in public copy: notes to the
// editor, and warnings to the reader about the client's own claims.
const EDITORIAL_PATTERNS = [
  { code: "EDITORIAL_NOTE_IN_COPY", re: /\b(nota (para el )?(editor|redactor|revisor)|note to (the )?editor|editor'?s note|TODO|TBD|placeholder|lorem ipsum)\b/i },
  { code: "EDITORIAL_NOTE_IN_COPY", re: /\b(formulario sugerido|campos? m[ií]nimos?|suggested form|minimum fields)\b/i },
  { code: "EDITORIAL_NOTE_IN_COPY", re: /\b(este (texto|documento|borrador|contenido) (las )?presenta|this (draft|document|text) presents)\b/i },
  { code: "EDITORIAL_NOTE_IN_COPY", re: /(sujet[oa]s? a verificaci[oó]n|pendiente de verificar|subject to verification|to be (verified|confirmed))/i },
  { code: "READER_WARNING_ABOUT_CLIENT", re: /(declaraci[oó]n(es)? del proveedor|seg[uú]n (la )?(declaraci[oó]n|comunicaci[oó]n) (del proveedor|de la empresa)|comunicaci[oó]n p[uú]blica de la empresa|la empresa (menciona|afirma|declara|indica|comunica|reporta)|provider'?s claims?|the (company|provider) (claims|states|says))/i },
  { code: "READER_WARNING_ABOUT_CLIENT", re: /\b(exige|solicita|pide) (los |las )?(documentos|evidencias|pruebas|constancias|p[oó]lizas)\b[^.\n]{0,80}(antes de (contratar|decidir|acudir)|que prueben)/i },
  { code: "READER_WARNING_ABOUT_CLIENT", re: /\b(verifica|confirma)[^.\n]{0,40}antes de (acudir|contratar|visitar)/i },
  { code: "READER_WARNING_ABOUT_CLIENT", re: /se[nñ]ales de confianza que debes solicitar/i },
];

/** Deterministic scan for editorial notes and reader warnings about the client in public copy. */
export function scanEditorialLanguage(markdown) {
  const findings = [];
  for (const line of String(markdown || "").split("\n")) {
    for (const { code, re } of EDITORIAL_PATTERNS) {
      if (re.test(line)) { findings.push({ code, severity: "blocker", value: line.trim().slice(0, 160) }); break; }
    }
  }
  return findings;
}

/** External (non-client) URLs present in the public copy. */
export function externalLinks(markdown, domain) {
  const host = String(domain || "").toLowerCase().replace(/^www\./, "");
  const urls = [...String(markdown || "").matchAll(/https?:\/\/[^\s)\]>"']+/g)].map((m) => m[0]);
  return urls.filter((u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, "") !== host; } catch { return false; } });
}

export function keywordStats(markdown, keyword) {
  const words = tokens(markdownToText(markdown));
  const phrase = tokens(keyword);
  if (!phrase.length || !words.length) return { occurrences: 0, density: 0, words: words.length };
  let occurrences = 0;
  for (let i = 0; i + phrase.length <= words.length; i++) {
    let ok = true;
    for (let j = 0; j < phrase.length; j++) if (words[i + j] !== phrase[j]) { ok = false; break; }
    if (ok) occurrences++;
  }
  return { occurrences, density: (occurrences * phrase.length) / words.length, words: words.length };
}

export function repetitionStats(markdown) {
  const sentences = markdownToText(markdown).split(/(?<=[.!?¡¿])\s+/).map((s) => normalizeForMatch(s)).filter((s) => s.split(" ").length >= 6);
  const counts = new Map();
  for (const s of sentences) counts.set(s, (counts.get(s) || 0) + 1);
  const repeated = [...counts.entries()].filter(([, n]) => n > 1).map(([s, n]) => ({ sentence: s.slice(0, 120), count: n }));
  const paragraphs = String(markdown || "").split(/\n{2,}/).map((p) => p.trim()).filter((p) => p && !p.startsWith("#") && !p.startsWith("-"));
  const openers = new Map();
  for (const p of paragraphs) {
    const opener = tokens(p).slice(0, 3).join(" ");
    if (opener) openers.set(opener, (openers.get(opener) || 0) + 1);
  }
  const repeatedOpeners = [...openers.entries()].filter(([, n]) => n > 2).map(([o, n]) => ({ opener: o, count: n }));
  return { repeated, repeatedOpeners };
}

// ---------------------------------------------------------------------------
// Duplicate content (same client only — callers must never pass other clients)

export function duplicateCheck(markdown, { pages = [], articles = [], excludePageId = null } = {}) {
  const draft = shingles(markdownToText(markdown));
  const matches = [];
  for (const page of pages) {
    if (!page.text || page.page_id === excludePageId) continue;
    const sim = similarity(draft, shingles(page.text));
    matches.push({ kind: "website_page", id: page.page_id, label: page.url, ...sim });
  }
  for (const article of articles) {
    if (!article.content) continue;
    const sim = similarity(draft, shingles(markdownToText(article.content)));
    matches.push({ kind: "article", id: article.id, label: article.title, ...sim });
  }
  matches.sort((a, b) => b.containment - a.containment);
  const top = matches[0];
  const level = !top ? "none" : top.containment >= 0.8 || top.jaccard >= 0.6 ? "severe" : top.containment >= 0.35 || top.jaccard >= 0.25 ? "warning" : "none";
  return { level, top: matches.slice(0, 5).map((m) => ({ ...m, containment: Number(m.containment.toFixed(3)), jaccard: Number(m.jaccard.toFixed(3)) })) };
}

// ---------------------------------------------------------------------------
// Local differentiation (location pages)

function stripLocation(text, location) {
  const loc = tokens(location);
  return tokens(text).filter((t) => !loc.includes(t)).join(" ");
}

export function localDifferentiation(markdown, context) {
  const location = context.meta.target_location;
  if (context.meta.content_type !== "location_page") return { applicable: false, level: "none" };
  const locTokens = tokens(location).filter((t) => t.length > 2);
  const mentions = (text) => locTokens.length > 0 && locTokens.every((t) => tokens(text).includes(t));
  const localEvidence = [];
  for (const fact of context.verified_facts) if (mentions(`${fact.label} ${fact.value}`)) localEvidence.push(fact.id);
  for (const page of context.crawler_evidence) if (mentions(`${page.title} ${page.h1} ${page.text}`)) localEvidence.push(page.id);
  for (const source of context.external_sources) if (mentions(`${source.title} ${source.excerpt}`)) localEvidence.push(source.id);
  const cityTemplate = [];
  for (const other of context.other_articles.filter((a) => a.content_type === "location_page" && a.target_location && normalizeForMatch(a.target_location) !== normalizeForMatch(location))) {
    const sim = similarity(stripLocation(markdownToText(markdown), location), stripLocation(markdownToText(other.content), other.target_location));
    cityTemplate.push({ id: other.id, location: other.target_location, containment: Number(sim.containment.toFixed(3)) });
  }
  const swap = cityTemplate.find((c) => c.containment >= 0.6);
  let level = "none";
  const reasons = [];
  if (!location) { level = "severe"; reasons.push("Location page has no target location."); }
  if (localEvidence.length < 2) { level = "severe"; reasons.push(`Only ${localEvidence.length} location-specific evidence item(s) for ${location || "target location"}.`); }
  else if (localEvidence.length < 4 && level !== "severe") { level = "warning"; reasons.push(`Limited local evidence (${localEvidence.length}).`); }
  if (swap) { level = "severe"; reasons.push(`Near-identical to location page for ${swap.location} after removing city names (containment ${swap.containment}).`); }
  return { applicable: true, level, local_evidence: localEvidence, city_template_matches: cityTemplate, reasons };
}

// ---------------------------------------------------------------------------
// High-risk topics

// Terms match at the START of a word ("credito" matches "créditos"); a trailing
// space means whole-word only. Ambiguous stems (e.g. "interes" → "interesante",
// "medic" → "medición") are deliberately avoided.
const RISK_TERMS = {
  medical: ["medico", "medica", "medicamento", "medical", "medicine", "salud ", "health ", "enfermedad", "disease", "diagnost", "sintoma", "symptom", "clinica", "clinic ", "farmac", "dermatolog", "cirugia", "surgery", "tratamiento medico", "medical treatment"],
  legal: ["abogad", "attorney", "lawyer", "demanda judicial", "lawsuit", "normativa", "regulation", "reglamento", "legal ", "legalmente", "ley federal", "ley general", "contrato", "contract "],
  financial: ["financiamiento", "financiacion", "financing", "credito", "credit ", "prestamo", "loan ", "loans ", "tasa de interes", "interest rate", "intereses", "inversion", "investment", "retorno de inversion", "roi ", "deducib", "deducción", "impuesto", "tax credit", "tax deduction", "hipoteca", "mortgage", "meses sin intereses"],
  safety: ["electrocu", "incendio", "fire hazard", "riesgo electrico", "descarga electrica", "electrical shock", "seguridad electrica", "electrical safety", "gas leak", "fuga de gas", "monoxido"],
  regulated: ["cfe ", "interconexion", "net metering", "medicion neta", "subsidio", "subsidy", "licencia", "license ", "certificacion oficial", "nom-"],
};

export function detectRisk(texts, modelCategories = []) {
  const haystack = ` ${normalizeForMatch(texts.join(" \n "))} `;
  const categories = new Set(modelCategories.filter((c) => RISK_TERMS[c]));
  const hits = {};
  for (const [category, terms] of Object.entries(RISK_TERMS)) {
    const found = terms.filter((term) => {
      const norm = normalizeForMatch(term);
      return term.endsWith(" ") ? haystack.includes(` ${norm} `) : haystack.includes(` ${norm}`);
    });
    if (found.length) { categories.add(category); hits[category] = found.slice(0, 5); }
  }
  return { high_risk: categories.size > 0, categories: [...categories], hits };
}

// ---------------------------------------------------------------------------
// Internal links

function sameUrl(a, b) {
  const clean = (u) => { try { const x = new URL(u); return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "") || "/"}`.toLowerCase(); } catch { return String(u).toLowerCase(); } };
  return clean(a) === clean(b);
}

/**
 * Validate links in the draft: internal links must point to indexable 200
 * pages of THIS website; external links only to collected research sources.
 * Invalid links are unlinked (anchor text kept). Repeated anchors beyond 2 uses
 * and repeat links to the same destination beyond 2 are unlinked.
 */
export function processLinks(markdown, context, pages) {
  const domain = String(context.meta.website_domain || "").toLowerCase().replace(/^www\./, "");
  const base = `https://${domain}`;
  const pageByUrl = pages.map((p) => ({ ...p }));
  const sources = context.external_sources;
  const anchors = new Map();
  const destinations = new Map();
  const inserted = [];
  const removed = [];
  let output = String(markdown || "");
  const links = linksFromMarkdown(output).sort((a, b) => b.index - a.index);
  const decisions = [];
  for (const link of [...links].reverse()) {
    let absolute;
    try { absolute = new URL(link.url, base).toString(); } catch { decisions.push({ link, keep: false, reason: "invalid URL" }); continue; }
    const host = new URL(absolute).hostname.toLowerCase().replace(/^www\./, "");
    const anchorKey = normalizeForMatch(link.anchor);
    if (host === domain) {
      const page = pageByUrl.find((p) => sameUrl(p.url, absolute));
      if (!page) { decisions.push({ link, keep: false, reason: "destination not found in crawled pages (possible broken link)" }); continue; }
      if (page.indexable === false) { decisions.push({ link, keep: false, reason: "destination is not indexable" }); continue; }
      if (page.status_code && page.status_code !== 200) { decisions.push({ link, keep: false, reason: `destination returned ${page.status_code}` }); continue; }
      const anchorCount = (anchors.get(anchorKey) || 0) + 1;
      const destCount = (destinations.get(page.id) || 0) + 1;
      if (anchorCount > 2) { decisions.push({ link, keep: false, reason: "anchor text repeated excessively" }); continue; }
      if (destCount > 2) { decisions.push({ link, keep: false, reason: "destination linked excessively" }); continue; }
      anchors.set(anchorKey, anchorCount);
      destinations.set(page.id, destCount);
      const candidate = context.internal_link_candidates.find((c) => c.page_id === page.id);
      decisions.push({ link, keep: true, internal: true, page, reason: candidate ? `Relevant internal page (${candidate.id}, relevance ${candidate.relevance})` : "Valid internal page on the same website" });
    } else {
      if (["service_page", "location_page", "existing_page_optimization"].includes(context.meta.content_type)) { decisions.push({ link, keep: false, reason: "external links are not used on commercial pages (sources stay internal evidence)" }); continue; }
      const source = sources.find((s) => sameUrl(s.url, absolute));
      if (!source) { decisions.push({ link, keep: false, reason: "external URL is not a collected research source" }); continue; }
      decisions.push({ link, keep: true, internal: false, source });
    }
  }
  for (const decision of decisions.sort((a, b) => b.link.index - a.link.index)) {
    const { link } = decision;
    if (!decision.keep) {
      output = output.slice(0, link.index) + link.anchor + output.slice(link.index + link.raw.length);
      removed.push({ url: link.url, anchor: link.anchor, reason: decision.reason });
    } else if (decision.internal) {
      inserted.push({ destination_page: decision.page.id, destination_url: decision.page.url, anchor_text: link.anchor, reason: decision.reason });
    }
  }
  const usedPages = new Set(inserted.map((l) => l.destination_page));
  const recommended = context.internal_link_candidates
    .filter((c) => !usedPages.has(c.page_id))
    .slice(0, 5)
    .map((c) => ({ destination_page: c.page_id, destination_url: c.url, anchor_text: "", reason: `Recommended (not inserted): ${c.title}` }));
  return { markdown: output, inserted: inserted.reverse(), removed: removed.reverse(), recommended };
}

// ---------------------------------------------------------------------------
// Metadata + structured data

export function checkMetadata(meta, context) {
  const issues = [];
  const title = String(meta.seo_title || "");
  const desc = String(meta.meta_description || "");
  if (title.length < 25 || title.length > 65) issues.push({ code: "SEO_TITLE_LENGTH", severity: "minor", description: `SEO title is ${title.length} characters (target 25–65).` });
  if (desc.length < 70 || desc.length > 165) issues.push({ code: "META_DESCRIPTION_LENGTH", severity: "minor", description: `Meta description is ${desc.length} characters (target 70–165).` });
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(meta.slug || ""))) issues.push({ code: "SLUG_FORMAT", severity: "minor", description: "Slug must be lowercase words separated by hyphens." });
  const coreTokens = tokens(context.meta.primary_keyword).filter((t) => t.length > 3);
  const titleTokens = new Set(tokens(title));
  if (coreTokens.length && coreTokens.filter((t) => titleTokens.has(t)).length / coreTokens.length < 0.5) {
    issues.push({ code: "SEO_TITLE_KEYWORD", severity: "minor", description: "SEO title does not reflect the primary keyword." });
  }
  return issues;
}

export function sanitizeSlug(value, fallback) {
  return slugify(value) || slugify(fallback) || "draft";
}

/** Build schema.org suggestions from actual content only (no ratings, prices or invented fields). */
export function buildStructuredData({ article, metadata, markdown, context, suggestions = [] }) {
  const url = context.meta.recommended_url ? new URL(context.meta.recommended_url, `https://${context.meta.website_domain}`).toString() : `https://${context.meta.website_domain}/${metadata.slug}`;
  const out = [];
  const applicable = new Map(suggestions.filter((s) => s.applicable).map((s) => [s.type, s.reason]));
  const type = article.content_type;
  const lang = context.meta.language;
  const headline = metadata.seo_title || article.title;
  if (type === "blog_article" || type === "guide" || type === "comparison") {
    const schemaType = type === "blog_article" ? "BlogPosting" : "Article";
    out.push({ type: schemaType, reason: applicable.get(schemaType) || `Editorial ${type.replace("_", " ")} content.`, jsonld: { "@context": "https://schema.org", "@type": schemaType, headline, description: metadata.meta_description, inLanguage: lang, mainEntityOfPage: url, publisher: { "@type": "Organization", name: context.meta.business_name } } });
  }
  if (type === "service_page" || type === "location_page") {
    const areaServed = context.meta.target_location || undefined;
    out.push({ type: "Service", reason: applicable.get("Service") || "Page describes a service offered by the business.", jsonld: { "@context": "https://schema.org", "@type": "Service", name: article.title || headline, description: metadata.meta_description, provider: { "@type": "Organization", name: context.meta.business_name, url: `https://${context.meta.website_domain}` }, ...(areaServed ? { areaServed } : {}), url } });
  }
  const faq = extractFaq(markdown);
  const faqWanted = type === "faq_page" || (faq.length >= 3 && applicable.has("FAQPage"));
  if (faqWanted && faq.length >= 2) {
    out.push({ type: "FAQPage", reason: applicable.get("FAQPage") || "Page contains a genuine question-and-answer section.", jsonld: { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.slice(0, 10).map((q) => ({ "@type": "Question", name: q.question, acceptedAnswer: { "@type": "Answer", text: q.answer } })) } });
  }
  const path = new URL(url).pathname.split("/").filter(Boolean);
  out.push({ type: "BreadcrumbList", reason: "Navigational context for the proposed URL.", jsonld: { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: context.meta.business_name || "Home", item: `https://${context.meta.website_domain}/` }, ...path.map((segment, index) => ({ "@type": "ListItem", position: index + 2, name: index === path.length - 1 ? headline : segment.replace(/-/g, " "), item: `https://${context.meta.website_domain}/${path.slice(0, index + 1).join("/")}` }))] } });
  return out;
}

export function extractFaq(markdown) {
  const lines = String(markdown || "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^#{2,4}\s+(.+\?)\s*$/);
    if (!match) continue;
    const answer = [];
    for (let j = i + 1; j < lines.length && !/^#{1,4}\s/.test(lines[j]); j++) if (lines[j].trim()) answer.push(lines[j].trim());
    if (answer.length) out.push({ question: match[1].replace(/^[¿]/, "¿").trim(), answer: markdownToText(answer.join(" ")).slice(0, 800) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Structure / language

export function structureStats(markdown, context) {
  const headings = headingsFromMarkdown(markdown);
  const h1 = headings.filter((h) => h.level === 1);
  const h2 = headings.filter((h) => h.level === 2);
  const keyword = normalizeForMatch(context.meta.primary_keyword);
  const keywordOnlyHeadings = headings.filter((h) => normalizeForMatch(h.text) === keyword).length;
  const detected = detectLanguage(markdown);
  const expected = languageBase(context.meta.language);
  const languageMismatch = detected.language !== "und" && expected !== "und" && detected.language !== expected && ["es", "en"].includes(expected);
  return { words: wordCount(markdown), h1: h1.length, h2: h2.length, headings: headings.length, keywordOnlyHeadings, detectedLanguage: detected.language, expectedLanguage: expected, languageMismatch };
}
