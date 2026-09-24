// Context Builder. Assembles the structured, tenant-scoped context the content
// pipeline is allowed to use, and keeps evidence categories strictly separate:
//
//   VERIFIED_FACTS    (F*)  business_facts that are verified / user_confirmed
//   UNVERIFIED_DATA   (U*)  client profile declarations + unverified/AI-inferred facts
//   CRAWLER_EVIDENCE  (C*)  text observed on the client's own website (untrusted data)
//   AI_INFERENCES     (I*)  Phase 3 strategy outputs (intent, clusters, reasons)
//   EXTERNAL_SOURCES  (S*)  research sources fetched by us (added later)
//
// Only F* may back a business-specific factual claim as VERIFIED.
import { normalizeForMatch, safeMultiline, safeText, tokens } from "./text.js";

export const SENSITIVE_FACT_TYPES = Object.freeze(["price", "financing", "warranty", "certification", "promotion", "phone", "email", "location"]);

export class TenantIsolationError extends Error {
  constructor(message) {
    super(message);
    this.name = "TenantIsolationError";
    this.code = "TENANT_MISMATCH";
    this.retryable = false;
  }
}

export function isVerifiedFact(fact) {
  if (!fact) return false;
  if (fact.verification_state === "ai_inferred" || fact.provenance === "ai_inferred") return false;
  return fact.verified === true || fact.verification_state === "verified" || fact.verification_state === "user_confirmed";
}

/** Throws unless every record belongs to the same organization/client/website. */
export function assertTenant(records, { organization, client, website }) {
  for (const [label, list] of Object.entries(records)) {
    for (const record of Array.isArray(list) ? list : [list]) {
      if (!record) continue;
      if (record.organization !== undefined && record.organization !== organization) throw new TenantIsolationError(`${label} ${record.id} belongs to another organization`);
      if (client && record.client !== undefined && record.client !== "" && record.client !== client) throw new TenantIsolationError(`${label} ${record.id} belongs to another client`);
      if (website && record.website !== undefined && record.website !== "" && record.website !== website) throw new TenantIsolationError(`${label} ${record.id} belongs to another website`);
    }
  }
}

const PROFILE_FIELDS = [
  ["industry", "Industry"],
  ["description", "Business description"],
  ["services", "Services"],
  ["products", "Products"],
  ["primary_location", "Primary location"],
  ["service_areas", "Service areas"],
  ["target_audience", "Target audience"],
  ["unique_selling_proposition", "Unique selling proposition"],
  ["primary_cta", "Primary call to action"],
  ["phone", "Phone"],
  ["email", "Email"],
];

function relevance(textValue, queryTokens) {
  if (!queryTokens.length) return 0;
  const set = new Set(tokens(textValue));
  let hits = 0;
  for (const token of queryTokens) if (token.length > 2 && set.has(token)) hits++;
  return hits / queryTokens.length;
}

function pageLabel(page) {
  return safeText(page.title || page.h1 || page.path || page.url, 200);
}

/**
 * Pure context assembly. `data` is already tenant-checked by loadJobData.
 * `pageTexts` maps page id -> fetched text of the client's own pages.
 */
export function buildContext(data, { pageTexts = new Map() } = {}) {
  const { article, client, website, facts = [], pages = [], links = [], issues = [], opportunity, keyword, cluster, clusterKeywords = [], planItem, otherArticles = [] } = data;
  const input = article.generation_input || {};
  const language = safeText(article.language || input.language || website.primary_language || client.primary_language || "en", 10);
  const primaryKeyword = safeText(article.primary_keyword || input.primary_keyword || keyword?.keyword || opportunity?.title_suggestion || "", 200);
  const targetLocation = safeText(article.target_location || input.target_location || "", 200);
  const queryTokens = tokens(`${primaryKeyword} ${targetLocation}`).filter((t) => t.length > 2);

  const verified_facts = [];
  const unverified_data = [];
  let f = 0;
  let u = 0;
  for (const fact of facts) {
    const entry = { type: fact.fact_type, label: safeText(fact.label, 200), value: safeText(fact.value, 1000), source: safeText(fact.source, 200), source_url: fact.source_url || "", record_id: fact.id };
    if (isVerifiedFact(fact)) verified_facts.push({ id: `F${++f}`, ...entry, verification_state: fact.verification_state || (fact.verified ? "verified" : "") });
    else unverified_data.push({ id: `U${++u}`, kind: "business_fact", ...entry, verification_state: fact.verification_state || "unverified", provenance: fact.provenance || "unknown" });
  }
  for (const [field, label] of PROFILE_FIELDS) {
    const value = safeText(client[field], 1500);
    if (value) unverified_data.push({ id: `U${++u}`, kind: "client_profile", type: field, label, value, source: "Client profile (declared, not verified)" });
  }
  for (const field of ["target_locations", "country"]) {
    const value = safeText(website[field], 300);
    if (value) unverified_data.push({ id: `U${++u}`, kind: "website_profile", type: field, label: field, value, source: "Website settings (declared)" });
  }

  const byId = new Map(pages.map((page) => [page.id, page]));
  const inbound = new Map();
  for (const link of links) if (link.destination_page) inbound.set(link.destination_page, (inbound.get(link.destination_page) || 0) + 1);

  const crawler_evidence = [];
  let c = 0;
  const scored = pages
    .map((page) => ({ page, score: relevance(`${page.title} ${page.h1} ${page.path} ${page.meta_description}`, queryTokens) + (page.path === "/" || page.path === "" ? 0.25 : 0) + (article.existing_page === page.id ? 10 : 0) }))
    .sort((a, b) => b.score - a.score);
  for (const { page } of scored.slice(0, 8)) {
    const headings = Array.isArray(page.headings) ? page.headings.slice(0, 25).map((h) => safeText(typeof h === "string" ? h : `${h.level ? `H${h.level}: ` : ""}${h.text || ""}`, 200)) : [];
    crawler_evidence.push({
      id: `C${++c}`,
      page_id: page.id,
      url: page.url,
      title: safeText(page.title, 300),
      h1: safeText(page.h1, 300),
      meta_description: safeText(page.meta_description, 400),
      headings,
      text: safeMultiline(pageTexts.get(page.id) || "", 5000),
    });
  }

  const ai_inferences = [];
  let i = 0;
  if (opportunity) {
    ai_inferences.push({ id: `I${++i}`, kind: "opportunity", value: safeText(`${opportunity.opportunity_type} → ${opportunity.recommended_page_type}: ${opportunity.reason}`, 1200), recommended_url: opportunity.recommended_url || "" });
  }
  if (planItem) ai_inferences.push({ id: `I${++i}`, kind: "plan_item", value: safeText(`${planItem.action}: ${planItem.proposed_title} — ${planItem.reason}`, 1200) });
  if (keyword) ai_inferences.push({ id: `I${++i}`, kind: "keyword", value: safeText(`${keyword.keyword} (intent: ${keyword.intent || "unknown"}, funnel: ${keyword.funnel_stage || "unknown"})`, 400) });
  if (cluster) ai_inferences.push({ id: `I${++i}`, kind: "cluster", value: safeText(`${cluster.name}: ${cluster.description || ""}`, 600) });
  const secondaryCandidates = clusterKeywords
    .map((k) => safeText(k.keyword, 120))
    .filter((k) => k && normalizeForMatch(k) !== normalizeForMatch(primaryKeyword))
    .slice(0, 12);
  if (secondaryCandidates.length) ai_inferences.push({ id: `I${++i}`, kind: "cluster_keywords", value: secondaryCandidates.join(", ") });
  const relevantIssues = issues
    .filter((issue) => !article.existing_page || issue.page === article.existing_page || !issue.page)
    .slice(0, 15)
    .map((issue) => ({ id: `I${++i}`, kind: "seo_issue", value: safeText(`${issue.severity} ${issue.issue_type}: ${issue.title || ""}`, 300) }));
  ai_inferences.push(...relevantIssues);

  const targetUrl = normalizeForMatch(article.recommended_url || opportunity?.recommended_url || "");
  const internal_link_candidates = pages
    .filter((page) => page.indexable !== false && (page.status_code === 200 || page.status_code === undefined) && page.id !== article.existing_page)
    .filter((page) => !targetUrl || !normalizeForMatch(page.url).endsWith(targetUrl))
    .map((page) => ({ page, score: relevance(`${page.title} ${page.h1} ${page.path}`, queryTokens) + (inbound.get(page.id) ? 0.05 : 0) + ((page.path === "/" || page.path === "") ? 0.2 : 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map(({ page, score }, index) => ({ id: `L${index + 1}`, page_id: page.id, url: page.url, title: pageLabel(page), relevance: Number(score.toFixed(2)) }));

  const existingPage = article.existing_page ? byId.get(article.existing_page) : null;
  return {
    meta: {
      content_type: article.content_type,
      language,
      primary_keyword: primaryKeyword,
      secondary_keyword_candidates: secondaryCandidates,
      target_location: targetLocation,
      recommended_url: safeText(article.recommended_url || opportunity?.recommended_url || "", 500),
      reason: safeText(input.reason || opportunity?.reason || planItem?.reason || "", 1200),
      business_name: safeText(client.business_name, 200),
      website_domain: safeText(website.domain, 200),
      brand_voice: safeText(client.brand_voice, 500) || null,
      existing_page: existingPage ? { page_id: existingPage.id, url: existingPage.url, title: existingPage.title } : null,
    },
    verified_facts,
    unverified_data,
    crawler_evidence,
    ai_inferences,
    internal_link_candidates,
    external_sources: [],
    other_articles: otherArticles.map((item) => ({ id: item.id, title: item.title, content_type: item.content_type, target_location: item.target_location || "", content: item.content || "" })),
    existing_content: existingPage ? safeMultiline(pageTexts.get(existingPage.id) || "", 20_000) : "",
    tenant: { organization: article.organization, client: article.client, website: article.website },
  };
}

export function attachSources(context, sources) {
  return {
    ...context,
    external_sources: sources.map((source, index) => ({
      id: `S${index + 1}`,
      record_id: source.id,
      url: source.url,
      title: safeText(source.title, 300),
      publisher: safeText(source.publisher, 200),
      source_type: source.source_type,
      excerpt: safeMultiline(source.excerpt, 4000),
    })),
  };
}

/** Every evidence id → category, used to validate model references. */
export function evidenceIndex(context) {
  const index = new Map();
  for (const item of context.verified_facts) index.set(item.id, { category: "verified_fact", item });
  for (const item of context.unverified_data) index.set(item.id, { category: "unverified", item });
  for (const item of context.crawler_evidence) index.set(item.id, { category: "crawler", item });
  for (const item of context.ai_inferences) index.set(item.id, { category: "ai_inference", item });
  for (const item of context.external_sources) index.set(item.id, { category: "external", item });
  return index;
}

const CLOSE_TAG = /<\/?\s*(untrusted_evidence|system|instructions?|assistant|developer)[^>]*>/gi;
function neutralize(value) {
  if (typeof value === "string") return value.replace(CLOSE_TAG, "[tag removed]");
  if (Array.isArray(value)) return value.map(neutralize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, neutralize(v)]));
  return value;
}

/**
 * Serialize context for a model. All tenant data (including crawled page text
 * and research excerpts) is wrapped as untrusted DATA; delimiter-like tags
 * inside the data are neutralized so they cannot close the data block.
 */
export function evidenceBlock(context, { include = ["verified_facts", "unverified_data", "crawler_evidence", "ai_inferences", "external_sources", "internal_link_candidates"], extra = {} } = {}) {
  const payload = { meta: context.meta };
  for (const key of include) payload[key] = context[key];
  Object.assign(payload, extra);
  return `<untrusted_evidence>\n${JSON.stringify(neutralize(payload))}\n</untrusted_evidence>`;
}
