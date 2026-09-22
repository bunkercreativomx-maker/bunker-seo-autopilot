// Provenance + verification-state helpers for business facts and strategy
// artifacts. Phase 4 must never convert AI-inferred values into factual claims,
// so every value that can carry a source carries an explicit provenance tag and
// a verification state. AI-inferred values are NEVER auto-verified.

export const PROVENANCE_SOURCES = Object.freeze([
  "user_provided",
  "website",
  "crawler",
  "manual",
  "external_source",
  "ai_inferred",
  "unknown",
]);

export const VERIFICATION_STATES = Object.freeze([
  "unverified",
  "verified",
  "ai_inferred",
  "user_confirmed",
  "unknown",
]);

// A value is only "verified" when a human (or a trusted external source) marked
// it so. AI inference can never promote a value to verified on its own.
export function isVerified(record) {
  if (record?.verified === true) return true;
  if (record?.verification_state === "verified") return true;
  if (record?.verification_state === "user_confirmed") return true;
  return false;
}

// Normalize an arbitrary provenance string to one of the supported tags.
export function normalizeProvenance(value) {
  const v = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (PROVENANCE_SOURCES.includes(v)) return v;
  if (v === "ai" || v === "ai_generated" || v === "ai_discovery") return "ai_inferred";
  if (v === "user" || v === "user_input" || v === "client") return "user_provided";
  if (v === "site" || v === "web" || v === "homepage") return "website";
  if (v === "crawl" || v === "crawled") return "crawler";
  if (v === "external" || v === "third_party") return "external_source";
  return "unknown";
}

// Default verification state for a given provenance. AI-inferred is never
// verified; user-provided and manual are treated as user-confirmed.
export function defaultVerificationState(provenance) {
  const p = normalizeProvenance(provenance);
  if (p === "ai_inferred") return "ai_inferred";
  if (p === "user_provided" || p === "manual") return "user_confirmed";
  if (p === "website" || p === "crawler" || p === "external_source") return "unverified";
  return "unknown";
}

// Human-readable labels for internal page-type enums. Internal enum values stay
// stable (no migration); only the UI label changes.
const PAGE_TYPE_LABELS = {
  service_page: "Service Page",
  location_page: "Location Page",
  blog_article: "Blog Article",
  comparison: "Comparison Page",
  guide: "Guide",
  faq: "FAQ Page",
  product_page: "Product Page",
  category_page: "Category Page",
  homepage: "Homepage",
  existing_page: "Existing Page Optimization",
  technical: "Technical Fix",
  other: "Other",
  // Worker-internal page_type enums (classify.js) map to the same labels.
  service: "Service Page",
  location: "Location Page",
  article: "Blog Article",
  product: "Product Page",
  utility: "Utility Page",
};

export function pageTypeLabel(value) {
  return PAGE_TYPE_LABELS[value] || value || "Other";
}

// Human-readable labels for opportunity types.
const OPPORTUNITY_LABELS = {
  create: "Create New Page",
  optimize: "Optimize Existing Page",
  expand: "Expand Existing Page",
  merge: "Merge Pages",
  internal_link: "Add Internal Link",
  location: "Create Location Page",
  service: "Create Service Page",
  refresh: "Refresh / Optimize",
  ignore: "Ignore",
};

export function opportunityLabel(value) {
  return OPPORTUNITY_LABELS[value] || value || "Other";
}

// Human-readable labels for search intent.
const INTENT_LABELS = {
  informational: "Informational",
  commercial: "Commercial",
  transactional: "Transactional",
  navigational: "Navigational",
  local: "Local",
  mixed: "Mixed",
};

export function intentLabel(value) {
  return INTENT_LABELS[value] || value || "Unknown";
}
