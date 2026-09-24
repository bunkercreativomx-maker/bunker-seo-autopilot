#!/usr/bin/env node
/**
 * Bunker SEO Autopilot — PocketBase schema bootstrap (Phases 1–4).
 * Creates/updates the multi-tenant collections and access rules idempotently.
 *
 * Usage:
 *   node scripts/setup-pocketbase.mjs
 *   PB_URL=... PB_ADMIN_EMAIL=... PB_ADMIN_PASSWORD=... node scripts/setup-pocketbase.mjs
 *
 * Idempotent: safe to run repeatedly. Superuser must already exist.
 */
const PB_URL = process.env.PB_URL || "http://127.0.0.1:8095";
const PB_ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL;
const PB_ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;
const USERS_COLL = "_pb_users_auth_";
if (!PB_ADMIN_EMAIL || !PB_ADMIN_PASSWORD) {
  throw new Error("PB_ADMIN_EMAIL and PB_ADMIN_PASSWORD are required; bootstrap credentials have no built-in fallback");
}

const REF = {}; // name -> collection id

let authToken;
async function authSuperuser() {
  if (authToken) return authToken;
  const r = await fetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: PB_ADMIN_EMAIL, password: PB_ADMIN_PASSWORD }),
  });
  if (!r.ok) throw new Error(`Superuser auth failed (${r.status}): ${await r.text()}`);
  authToken = (await r.json()).token;
  return authToken;
}

async function request(path, opts = {}, auth = true) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (auth) headers.Authorization = `Bearer ${await authSuperuser()}`;
  return fetch(`${PB_URL}${path}`, { ...opts, headers });
}

async function getCollection(name, { allowMissing = false } = {}) {
  const r = await request(`/api/collections/${name}`);
  if (allowMissing && r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${name} failed (${r.status}): ${await r.text()}`);
  return r.json();
}

async function patchCollection(name, obj) {
  const ex = await getCollection(name); // resolve id
  const r = await request(`/api/collections/${ex.id}`, { method: "PATCH", body: JSON.stringify(obj) });
  if (!r.ok) throw new Error(`PATCH ${name} failed (${r.status}): ${await r.text()}`);
  return r.json();
}

async function ensureCollection(name, fields, rules, { bareName, indexes = [] } = {}) {
  const ex = await getCollection(name, { allowMissing: true });
  if (ex) {
    const merged = { ...ex, ...rules };
    for (const f of fields) {
      if (!merged.fields.some((x) => x.name === f.name)) merged.fields.push(f);
    }
    // merge index definitions (unique constraints etc.), dedupe by SQL text
    const current = Array.isArray(ex.indexes) ? ex.indexes : [];
    for (const idx of indexes) {
      if (!current.includes(idx)) current.push(idx);
    }
    merged.indexes = current;
    await patchCollection(name, merged);
    REF[bareName || name] = ex.id;
    console.log(`ℹ️  ${name} exists (${ex.id}) — rules/fields/indexes ensured`);
    return ex.id;
  }
  const body = { name, type: "base", fields, indexes, ...rules };
  const r = await request(`/api/collections`, { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Create ${name} failed (${r.status}): ${await r.text()}`);
  const j = await r.json();
  REF[bareName || name] = j.id;
  console.log(`✓ ${name} created (${j.id})`);
  return j.id;
}

async function ensureSelectValues(name, fieldName, values) {
  const col = await getCollection(name);
  const field = col.fields.find((f) => f.name === fieldName);
  if (!field) throw new Error(`${name}.${fieldName} missing`);
  const merged = [...new Set([...(field.values || []), ...values])];
  if (merged.length === (field.values || []).length) return;
  field.values = merged;
  await patchCollection(name, col);
  console.log(`✓ ${name}.${fieldName} select values extended`);
}

function rel(name) {
  const id = REF[name];
  if (!id) throw new Error(`Relation target "${name}" not created yet`);
  return id;
}

// Rules for collections the app writes ONLY via the admin (superuser) client.
// Users may read their own org's rows but never create/update/delete directly.
const ADMIN_READ_RULES = {
  listRule: 'organization.id = @request.auth.organization.id',
  viewRule: 'organization.id = @request.auth.organization.id',
  createRule: null,
  updateRule: null,
  deleteRule: null,
};

async function main() {
  // --- organizations ---
  await ensureCollection("organizations", [
    { name: "name", type: "text", required: true },
    { name: "slug", type: "text", required: true },
    { name: "status", type: "select", values: ["active", "inactive"], maxSelect: 1, required: true },
    { name: "created_at", type: "date", required: false },
  ], {
    listRule: '@request.auth.organization.id = id',
    viewRule: '@request.auth.organization.id = id',
    createRule: null,
    updateRule: null,
    deleteRule: null,
  });

  // --- clients ---
  await ensureCollection("clients", [
    { name: "organization", type: "relation", maxSelect: 1, collectionId: rel("organizations"), required: true, cascadeDelete: false },
    { name: "business_name", type: "text", required: true },
    { name: "slug", type: "text", required: true },
    { name: "industry", type: "text" },
    { name: "description", type: "editor" },
    { name: "primary_language", type: "text" },
    { name: "secondary_languages", type: "text" },
    { name: "country", type: "text" },
    { name: "primary_location", type: "text" },
    { name: "service_areas", type: "text" },
    { name: "target_audience", type: "text" },
    { name: "brand_voice", type: "text" },
    { name: "services", type: "text" },
    { name: "products", type: "text" },
    { name: "unique_selling_proposition", type: "text" },
    { name: "primary_cta", type: "text" },
    { name: "phone", type: "text" },
    { name: "email", type: "email" },
    { name: "status", type: "select", values: ["active", "inactive", "archived"], maxSelect: 1, required: true },
    { name: "created_at", type: "date", required: false },
  ], {
    listRule: 'organization.id = @request.auth.organization.id',
    viewRule: 'organization.id = @request.auth.organization.id',
    createRule: 'organization.id = @request.auth.organization.id && @request.auth.role != "viewer"',
    updateRule: 'organization.id = @request.auth.organization.id && @request.auth.role != "viewer"',
    deleteRule: null,
  });

  // --- websites ---
  await ensureCollection("websites", [
    { name: "organization", type: "relation", maxSelect: 1, collectionId: rel("organizations"), required: true, cascadeDelete: false },
    { name: "client", type: "relation", maxSelect: 1, collectionId: rel("clients"), required: true, cascadeDelete: false },
    { name: "name", type: "text", required: true },
    { name: "domain", type: "text", required: true },
    { name: "platform", type: "select", values: ["nextjs", "react", "wordpress", "custom", "other"], maxSelect: 1, required: true },
    { name: "primary_language", type: "text" },
    { name: "country", type: "text" },
    { name: "target_locations", type: "text" },
    { name: "sitemap_url", type: "text" },
    { name: "robots_url", type: "text" },
    { name: "blog_url", type: "text" },
    { name: "status", type: "select", values: ["active", "inactive", "archived"], maxSelect: 1, required: true },
    { name: "created_at", type: "date", required: false },
  ], {
    listRule: 'organization.id = @request.auth.organization.id',
    viewRule: 'organization.id = @request.auth.organization.id',
    createRule: 'organization.id = @request.auth.organization.id && @request.auth.role != "viewer"',
    updateRule: 'organization.id = @request.auth.organization.id && @request.auth.role != "viewer"',
    deleteRule: null,
  });

  // --- activity_logs ---
  await ensureCollection("activity_logs", [
    { name: "organization", type: "relation", maxSelect: 1, collectionId: rel("organizations"), required: true, cascadeDelete: false },
    { name: "user", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false },
    { name: "client", type: "relation", maxSelect: 1, collectionId: rel("clients"), required: false },
    { name: "website", type: "relation", maxSelect: 1, collectionId: rel("websites"), required: false },
    { name: "action", type: "text", required: true },
    { name: "entity_type", type: "text" },
    { name: "entity_id", type: "text" },
    { name: "metadata", type: "json" },
    { name: "created_at", type: "date", required: false },
  ], {
    listRule: 'organization.id = @request.auth.organization.id',
    viewRule: 'organization.id = @request.auth.organization.id',
    createRule: null,
    updateRule: null,
    deleteRule: null,
  });

  // ---------- PHASE 2: website intelligence collections ----------
  // All written by the crawler worker via the admin client; users read scoped to org.
  // Tenant isolation enforced on each collection (organization.* rules).

  // --- website_pages --- one row per crawled URL
  await ensureCollection("website_pages", [
    { name: "organization", type: "relation", maxSelect: 1, collectionId: rel("organizations"), required: true, cascadeDelete: false },
    { name: "client", type: "relation", maxSelect: 1, collectionId: rel("clients"), required: true, cascadeDelete: false },
    { name: "website", type: "relation", maxSelect: 1, collectionId: rel("websites"), required: true, cascadeDelete: true },
    { name: "url", type: "text", required: true },
    { name: "normalized_url", type: "text", required: true },
    { name: "path", type: "text" },
    { name: "status_code", type: "number", required: false },
    { name: "content_type", type: "text" },
    { name: "indexable", type: "bool" },
    { name: "indexability_reason", type: "text" },
    { name: "canonical_url", type: "text" },
    { name: "title", type: "text" },
    { name: "title_length", type: "number" },
    { name: "meta_description", type: "text" },
    { name: "meta_description_length", type: "number" },
    { name: "h1", type: "editor" },
    { name: "h1_count", type: "number" },
    { name: "headings", type: "json" },
    { name: "word_count", type: "number" },
    { name: "language", type: "text" },
    { name: "robots_directives", type: "json" },
    { name: "schema_types", type: "json" },
    { name: "internal_links_count", type: "number" },
    { name: "external_links_count", type: "number" },
    { name: "images_count", type: "number" },
    { name: "images_missing_alt", type: "number" },
    { name: "content_hash", type: "text" },
    { name: "crawl_depth", type: "number" },
    { name: "last_crawled_at", type: "date", required: false },
    { name: "created_at", type: "date", required: false },
  ], ADMIN_READ_RULES, {
    bareName: "website_pages",
    indexes: [
      'CREATE UNIQUE INDEX idx_pages_website_url ON website_pages (website, normalized_url)',
      'CREATE INDEX idx_pages_website_idx ON website_pages (website)',
    ],
  });

  // --- crawl_jobs ---
  await ensureCollection("crawl_jobs", [
    { name: "organization", type: "relation", maxSelect: 1, collectionId: rel("organizations"), required: true, cascadeDelete: false },
    { name: "client", type: "relation", maxSelect: 1, collectionId: rel("clients"), required: true, cascadeDelete: false },
    { name: "website", type: "relation", maxSelect: 1, collectionId: rel("websites"), required: true, cascadeDelete: true },
    { name: "status", type: "select", values: ["queued", "running", "completed", "completed_with_errors", "failed", "cancelled"], maxSelect: 1, required: true },
    { name: "started_at", type: "date", required: false },
    { name: "completed_at", type: "date", required: false },
    { name: "pages_discovered", type: "number" },
    { name: "pages_crawled", type: "number" },
    { name: "pages_failed", type: "number" },
    { name: "errors_count", type: "number" },
    { name: "triggered_by", type: "text" },
    { name: "configuration", type: "json" },
    { name: "error_message", type: "text" },
    { name: "created_at", type: "date", required: false },
  ], {
    // users create jobs (Analyze button); worker updates them (status/progress). Worker is superuser -> bypasses.
    listRule: 'organization.id = @request.auth.organization.id',
    viewRule: 'organization.id = @request.auth.organization.id',
    createRule: 'organization.id = @request.auth.organization.id && @request.auth.role != "viewer"',
    updateRule: null, // worker only
    deleteRule: null,
  }, {
    bareName: "crawl_jobs",
    indexes: ['CREATE INDEX idx_crawl_jobs_status ON crawl_jobs (status, created_at)'],
  });

  // --- seo_issues ---
  await ensureCollection("seo_issues", [
    { name: "organization", type: "relation", maxSelect: 1, collectionId: rel("organizations"), required: true, cascadeDelete: false },
    { name: "client", type: "relation", maxSelect: 1, collectionId: rel("clients"), required: true, cascadeDelete: false },
    { name: "website", type: "relation", maxSelect: 1, collectionId: rel("websites"), required: true, cascadeDelete: true },
    { name: "page", type: "relation", maxSelect: 1, collectionId: rel("website_pages"), required: false, cascadeDelete: true },
    { name: "category", type: "text" },
    { name: "severity", type: "select", values: ["critical", "high", "medium", "low", "opportunity"], maxSelect: 1, required: true },
    { name: "issue_type", type: "text", required: true },
    { name: "title", type: "text" },
    { name: "description", type: "editor" },
    { name: "evidence", type: "json" },
    { name: "recommended_action", type: "editor" },
    { name: "status", type: "select", values: ["open", "ignored", "resolved"], maxSelect: 1, required: true },
    { name: "first_detected_at", type: "date", required: false },
    { name: "last_detected_at", type: "date", required: false },
    { name: "resolved_at", type: "date", required: false },
    { name: "created_at", type: "date", required: false },
  ], ADMIN_READ_RULES, {
    bareName: "seo_issues",
    indexes: ['CREATE INDEX idx_seo_issues_website_type ON seo_issues (website, issue_type)'],
  });

  // --- website_snapshots ---
  await ensureCollection("website_snapshots", [
    { name: "organization", type: "relation", maxSelect: 1, collectionId: rel("organizations"), required: true, cascadeDelete: false },
    { name: "client", type: "relation", maxSelect: 1, collectionId: rel("clients"), required: true, cascadeDelete: false },
    { name: "website", type: "relation", maxSelect: 1, collectionId: rel("websites"), required: true, cascadeDelete: true },
    { name: "crawl_job", type: "relation", maxSelect: 1, collectionId: rel("crawl_jobs"), required: false, cascadeDelete: true },
    { name: "total_pages", type: "number" },
    { name: "indexable_pages", type: "number" },
    { name: "non_indexable_pages", type: "number" },
    { name: "broken_pages", type: "number" },
    { name: "total_issues", type: "number" },
    { name: "critical_issues", type: "number" },
    { name: "high_issues", type: "number" },
    { name: "medium_issues", type: "number" },
    { name: "low_issues", type: "number" },
    { name: "opportunities", type: "number" },
    { name: "created_at", type: "date", required: false },
  ], ADMIN_READ_RULES, { bareName: "website_snapshots" });

  // --- page_links --- internal link graph
  await ensureCollection("page_links", [
    { name: "organization", type: "relation", maxSelect: 1, collectionId: rel("organizations"), required: true, cascadeDelete: false },
    { name: "client", type: "relation", maxSelect: 1, collectionId: rel("clients"), required: true, cascadeDelete: false },
    { name: "website", type: "relation", maxSelect: 1, collectionId: rel("websites"), required: true, cascadeDelete: true },
    { name: "source_page", type: "relation", maxSelect: 1, collectionId: rel("website_pages"), required: true, cascadeDelete: true },
    { name: "destination_url", type: "text", required: true },
    { name: "destination_page", type: "relation", maxSelect: 1, collectionId: rel("website_pages"), required: false, cascadeDelete: true },
    { name: "anchor_text", type: "text" },
    { name: "link_type", type: "select", values: ["internal", "external"], maxSelect: 1, required: true },
    { name: "status_code", type: "number" },
    { name: "created_at", type: "date", required: false },
  ], ADMIN_READ_RULES, {
    bareName: "page_links",
    indexes: ['CREATE INDEX idx_page_links_website_src ON page_links (website, source_page)'],
  });

  // --- website_changes ---
  await ensureCollection("website_changes", [
    { name: "organization", type: "relation", maxSelect: 1, collectionId: rel("organizations"), required: true, cascadeDelete: false },
    { name: "client", type: "relation", maxSelect: 1, collectionId: rel("clients"), required: true, cascadeDelete: false },
    { name: "website", type: "relation", maxSelect: 1, collectionId: rel("websites"), required: true, cascadeDelete: true },
    { name: "page", type: "relation", maxSelect: 1, collectionId: rel("website_pages"), required: false, cascadeDelete: true },
    { name: "change_type", type: "text", required: true },
    { name: "old_value", type: "text" },
    { name: "new_value", type: "text" },
    { name: "detected_at", type: "date", required: false },
    { name: "crawl_job", type: "relation", maxSelect: 1, collectionId: rel("crawl_jobs"), required: false, cascadeDelete: true },
    { name: "created_at", type: "date", required: false },
  ], ADMIN_READ_RULES, {
    bareName: "website_changes",
    indexes: ['CREATE INDEX idx_changes_website ON website_changes (website, detected_at)'],
  });

  // ---------- PHASE 3: SEO intelligence collections ----------
  // Strategy artifacts are worker-owned. Authenticated users may read rows in
  // their tenant, while all edits (including human overrides) go through a
  // trusted server action/admin client so generated fields cannot be tampered
  // with directly. The one exception is creating a strictly pinned queued job.
  const tenantFields = () => [
    { name: "organization", type: "relation", maxSelect: 1, collectionId: rel("organizations"), required: true, cascadeDelete: false },
    { name: "client", type: "relation", maxSelect: 1, collectionId: rel("clients"), required: true, cascadeDelete: false },
    { name: "website", type: "relation", maxSelect: 1, collectionId: rel("websites"), required: true, cascadeDelete: true },
  ];
  const timestamps = () => [
    { name: "created_at", type: "date", required: false },
    { name: "updated_at", type: "date", required: false },
  ];
  const overrideFields = () => [
    { name: "manual_override", type: "bool" },
    { name: "manual_fields", type: "json" },
    { name: "overridden_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    { name: "overridden_at", type: "date", required: false },
  ];

  await ensureCollection("business_facts", [
    ...tenantFields(),
    { name: "fact_type", type: "select", values: ["business_name", "service", "product", "location", "service_area", "phone", "email", "price", "financing", "warranty", "certification", "promotion", "brand", "other"], maxSelect: 1, required: true },
    { name: "label", type: "text", required: true },
    { name: "value", type: "editor", required: true },
    { name: "source", type: "text", required: true },
    { name: "source_url", type: "url" },
    { name: "verified", type: "bool" },
    { name: "verified_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    { name: "verified_at", type: "date", required: false },
    // Data provenance: where a business fact came from. AI-inferred values are
    // never auto-verified; Phase 4 must not convert them into factual claims.
    { name: "provenance", type: "select", values: ["user_provided", "website", "crawler", "manual", "external_source", "ai_inferred", "unknown"], maxSelect: 1, required: false },
    { name: "verification_state", type: "select", values: ["unverified", "verified", "ai_inferred", "user_confirmed", "unknown"], maxSelect: 1, required: false },
    ...overrideFields(),
    ...timestamps(),
  ], ADMIN_READ_RULES, {
    bareName: "business_facts",
    indexes: ['CREATE INDEX idx_business_facts_website_type ON business_facts (website, fact_type)'],
  });

  await ensureCollection("strategy_jobs", [
    ...tenantFields(),
    { name: "status", type: "select", values: ["queued", "running", "completed", "failed", "cancelled"], maxSelect: 1, required: true },
    { name: "step", type: "text" },
    { name: "progress", type: "number", min: 0, max: 100 },
    { name: "started_at", type: "date", required: false },
    { name: "completed_at", type: "date", required: false },
    { name: "error", type: "editor" },
    { name: "triggered_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: true, cascadeDelete: false },
    { name: "configuration", type: "json" },
    ...timestamps(),
  ], {
    listRule: 'organization.id = @request.auth.organization.id',
    viewRule: 'organization.id = @request.auth.organization.id',
    createRule: 'organization.id = @request.auth.organization.id && client.organization.id = organization.id && website.organization.id = organization.id && website.client.id = client.id && triggered_by.id = @request.auth.id && status = "queued" && progress = 0 && @request.auth.role != "viewer"',
    updateRule: null,
    deleteRule: null,
  }, {
    bareName: "strategy_jobs",
    indexes: ['CREATE INDEX idx_strategy_jobs_status ON strategy_jobs (status, created_at)'],
  });

  await ensureCollection("strategy_versions", [
    ...tenantFields(),
    { name: "strategy_job", type: "relation", maxSelect: 1, collectionId: rel("strategy_jobs"), required: false, cascadeDelete: false },
    { name: "version", type: "number", required: true, min: 1, onlyInt: true },
    { name: "summary", type: "editor" },
    { name: "generated_at", type: "date", required: true },
    { name: "generated_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    { name: "configuration", type: "json" },
    { name: "created_at", type: "date", required: false },
    { name: "updated_at", type: "date", required: false },
  ], ADMIN_READ_RULES, {
    bareName: "strategy_versions",
    indexes: ['CREATE UNIQUE INDEX idx_strategy_versions_website_version ON strategy_versions (website, version)'],
  });

  // Keywords are created before clusters to break the keyword↔cluster relation
  // cycle. The cluster relation is added idempotently after topic_clusters.
  await ensureCollection("keywords", [
    ...tenantFields(),
    { name: "strategy_version", type: "relation", maxSelect: 1, collectionId: rel("strategy_versions"), required: true, cascadeDelete: true },
    { name: "keyword", type: "text", required: true },
    { name: "normalized_keyword", type: "text", required: true },
    { name: "language", type: "text", required: true },
    { name: "country", type: "text" },
    { name: "target_location", type: "text" },
    { name: "intent", type: "select", values: ["informational", "commercial", "transactional", "navigational", "local", "mixed"], maxSelect: 1 },
    { name: "intent_confidence", type: "number", min: 0, max: 1 },
    { name: "funnel_stage", type: "select", values: ["awareness", "consideration", "conversion", "retention", "unknown"], maxSelect: 1 },
    { name: "topic", type: "text" },
    { name: "source", type: "select", values: ["manual", "website_crawler", "existing_page_content", "services", "products", "locations", "google_search_console", "external_keyword_api", "ai_discovery", "competitor_analysis"], maxSelect: 1, required: true },
    { name: "source_query", type: "text" },
    { name: "existing_target_page", type: "relation", maxSelect: 1, collectionId: rel("website_pages"), required: false, cascadeDelete: false },
    { name: "recommended_target_page", type: "text" },
    { name: "opportunity_type", type: "select", values: ["create", "optimize", "expand", "merge", "internal_link", "location", "service", "refresh", "ignore"], maxSelect: 1 },
    { name: "recommended_page_type", type: "select", values: ["service_page", "location_page", "blog_article", "comparison", "guide", "faq", "product_page", "category_page", "homepage", "existing_page", "other"], maxSelect: 1 },
    { name: "priority", type: "select", values: ["critical", "high", "medium", "low"], maxSelect: 1 },
    { name: "status", type: "select", values: ["discovered", "reviewed", "approved", "targeted", "ignored"], maxSelect: 1, required: true },
    // PocketBase number fields coerce null to 0. JSON preserves the required
    // number-or-null semantics and prevents unavailable metrics looking real.
    { name: "search_volume", type: "json" },
    { name: "cpc", type: "json" },
    { name: "keyword_difficulty", type: "json" },
    { name: "metrics_source", type: "text" },
    { name: "metrics_updated_at", type: "date", required: false },
    { name: "confidence", type: "number", min: 0, max: 1 },
    { name: "evidence", type: "json" },
    ...overrideFields(),
    ...timestamps(),
  ], ADMIN_READ_RULES, {
    bareName: "keywords",
    indexes: [
      'CREATE INDEX idx_keywords_website_normalized ON keywords (website, normalized_keyword)',
      'CREATE INDEX idx_keywords_version_status ON keywords (strategy_version, status)',
    ],
  });

  await ensureCollection("topic_clusters", [
    ...tenantFields(),
    { name: "strategy_version", type: "relation", maxSelect: 1, collectionId: rel("strategy_versions"), required: true, cascadeDelete: true },
    { name: "name", type: "text", required: true },
    { name: "description", type: "editor" },
    { name: "primary_topic", type: "text", required: true },
    { name: "pillar_keyword", type: "relation", maxSelect: 1, collectionId: rel("keywords"), required: false, cascadeDelete: false },
    { name: "pillar_page", type: "relation", maxSelect: 1, collectionId: rel("website_pages"), required: false, cascadeDelete: false },
    { name: "status", type: "select", values: ["draft", "reviewed", "approved", "archived"], maxSelect: 1, required: true },
    { name: "confidence", type: "number", min: 0, max: 1 },
    { name: "evidence", type: "json" },
    ...overrideFields(),
    ...timestamps(),
  ], ADMIN_READ_RULES, {
    bareName: "topic_clusters",
    indexes: ['CREATE INDEX idx_topic_clusters_version ON topic_clusters (strategy_version, status)'],
  });

  // Add the relation omitted during initial keyword creation.
  await ensureCollection("keywords", [
    { name: "cluster", type: "relation", maxSelect: 1, collectionId: rel("topic_clusters"), required: false, cascadeDelete: false },
  ], ADMIN_READ_RULES, { bareName: "keywords" });

  await ensureCollection("keyword_page_mappings", [
    ...tenantFields(),
    { name: "strategy_version", type: "relation", maxSelect: 1, collectionId: rel("strategy_versions"), required: true, cascadeDelete: true },
    { name: "keyword", type: "relation", maxSelect: 1, collectionId: rel("keywords"), required: true, cascadeDelete: true },
    { name: "current_page", type: "relation", maxSelect: 1, collectionId: rel("website_pages"), required: false, cascadeDelete: false },
    { name: "recommended_page", type: "text" },
    { name: "mapping_type", type: "select", values: ["existing_target", "recommended_existing", "new_service_page", "new_location_page", "new_blog_post", "new_guide", "merge", "ignore"], maxSelect: 1, required: true },
    { name: "confidence", type: "number", min: 0, max: 1 },
    { name: "reason", type: "editor", required: true },
    { name: "evidence", type: "json" },
    { name: "status", type: "select", values: ["proposed", "reviewed", "approved", "ignored"], maxSelect: 1, required: true },
    ...overrideFields(),
    ...timestamps(),
  ], ADMIN_READ_RULES, {
    bareName: "keyword_page_mappings",
    indexes: ['CREATE UNIQUE INDEX idx_keyword_mapping_version_keyword ON keyword_page_mappings (strategy_version, keyword)'],
  });

  await ensureCollection("content_opportunities", [
    ...tenantFields(),
    { name: "strategy_version", type: "relation", maxSelect: 1, collectionId: rel("strategy_versions"), required: true, cascadeDelete: true },
    { name: "keyword", type: "relation", maxSelect: 1, collectionId: rel("keywords"), required: false, cascadeDelete: false },
    { name: "cluster", type: "relation", maxSelect: 1, collectionId: rel("topic_clusters"), required: false, cascadeDelete: false },
    { name: "opportunity_type", type: "select", values: ["create", "optimize", "expand", "merge", "internal_link", "location", "service", "refresh", "ignore"], maxSelect: 1, required: true },
    { name: "recommended_page_type", type: "select", values: ["service_page", "location_page", "blog_article", "comparison", "guide", "faq", "product_page", "category_page", "homepage", "existing_page", "other"], maxSelect: 1 },
    { name: "existing_page", type: "relation", maxSelect: 1, collectionId: rel("website_pages"), required: false, cascadeDelete: false },
    { name: "recommended_url", type: "text" },
    { name: "title_suggestion", type: "text" },
    { name: "reason", type: "editor", required: true },
    { name: "priority", type: "select", values: ["critical", "high", "medium", "low"], maxSelect: 1, required: true },
    { name: "status", type: "select", values: ["proposed", "reviewed", "approved", "skipped", "completed"], maxSelect: 1, required: true },
    { name: "evidence", type: "json", required: true },
    { name: "confidence", type: "number", min: 0, max: 1 },
    ...overrideFields(),
    ...timestamps(),
  ], ADMIN_READ_RULES, {
    bareName: "content_opportunities",
    indexes: ['CREATE INDEX idx_content_opportunities_version_priority ON content_opportunities (strategy_version, priority)'],
  });

  await ensureCollection("cannibalization_issues", [
    ...tenantFields(),
    { name: "strategy_version", type: "relation", maxSelect: 1, collectionId: rel("strategy_versions"), required: true, cascadeDelete: true },
    { name: "keyword_group", type: "text", required: true },
    { name: "pages", type: "relation", maxSelect: 99, collectionId: rel("website_pages"), required: true, cascadeDelete: false },
    { name: "reason", type: "editor", required: true },
    { name: "severity", type: "select", values: ["high", "medium", "low"], maxSelect: 1, required: true },
    { name: "recommended_action", type: "editor", required: true },
    { name: "status", type: "select", values: ["open", "reviewed", "ignored", "resolved"], maxSelect: 1, required: true },
    { name: "confidence", type: "number", min: 0, max: 1 },
    { name: "evidence", type: "json", required: true },
    ...overrideFields(),
    ...timestamps(),
  ], ADMIN_READ_RULES, {
    bareName: "cannibalization_issues",
    indexes: ['CREATE INDEX idx_cannibalization_version_status ON cannibalization_issues (strategy_version, status)'],
  });

  await ensureCollection("content_plans", [
    ...tenantFields(),
    { name: "strategy_version", type: "relation", maxSelect: 1, collectionId: rel("strategy_versions"), required: true, cascadeDelete: true },
    { name: "name", type: "text", required: true },
    { name: "period", type: "select", values: ["30_days", "60_days", "90_days", "30_60_90"], maxSelect: 1, required: true },
    { name: "start_date", type: "date", required: false },
    { name: "end_date", type: "date", required: false },
    { name: "status", type: "select", values: ["draft", "reviewed", "approved", "active", "completed", "archived"], maxSelect: 1, required: true },
    ...overrideFields(),
    ...timestamps(),
  ], ADMIN_READ_RULES, {
    bareName: "content_plans",
    indexes: ['CREATE INDEX idx_content_plans_version_status ON content_plans (strategy_version, status)'],
  });

  await ensureCollection("content_plan_items", [
    ...tenantFields(),
    { name: "strategy_version", type: "relation", maxSelect: 1, collectionId: rel("strategy_versions"), required: true, cascadeDelete: true },
    { name: "plan", type: "relation", maxSelect: 1, collectionId: rel("content_plans"), required: true, cascadeDelete: true },
    { name: "opportunity", type: "relation", maxSelect: 1, collectionId: rel("content_opportunities"), required: false, cascadeDelete: false },
    { name: "keyword", type: "relation", maxSelect: 1, collectionId: rel("keywords"), required: false, cascadeDelete: false },
    { name: "cluster", type: "relation", maxSelect: 1, collectionId: rel("topic_clusters"), required: false, cascadeDelete: false },
    { name: "action", type: "select", values: ["create_new_page", "create_blog_post", "optimize_existing_page", "expand_existing_page", "merge_content", "add_internal_links", "create_location_page", "create_service_page", "fix_technical_issue", "ignore"], maxSelect: 1, required: true },
    { name: "page_type", type: "select", values: ["service_page", "location_page", "blog_article", "comparison", "guide", "faq", "product_page", "category_page", "homepage", "existing_page", "technical", "other"], maxSelect: 1 },
    { name: "existing_page", type: "relation", maxSelect: 1, collectionId: rel("website_pages"), required: false, cascadeDelete: false },
    { name: "proposed_url", type: "text" },
    { name: "proposed_title", type: "text" },
    { name: "priority", type: "select", values: ["critical", "high", "medium", "low"], maxSelect: 1, required: true },
    { name: "scheduled_period", type: "select", values: ["days_1_30", "days_31_60", "days_61_90"], maxSelect: 1, required: true },
    { name: "status", type: "select", values: ["planned", "approved", "in_progress", "completed", "skipped"], maxSelect: 1, required: true },
    { name: "reason", type: "editor", required: true },
    { name: "evidence", type: "json" },
    ...overrideFields(),
    ...timestamps(),
  ], ADMIN_READ_RULES, {
    bareName: "content_plan_items",
    indexes: ['CREATE INDEX idx_plan_items_plan_period ON content_plan_items (plan, scheduled_period)'],
  });

  await ensureCollection("ai_usage", [
    ...tenantFields(),
    { name: "job", type: "relation", maxSelect: 1, collectionId: rel("strategy_jobs"), required: false, cascadeDelete: true },
    { name: "strategy_version", type: "relation", maxSelect: 1, collectionId: rel("strategy_versions"), required: false, cascadeDelete: true },
    { name: "task", type: "select", values: ["keyword_discovery", "intent_classification", "clustering", "content_gap", "mapping", "prioritization"], maxSelect: 1, required: true },
    { name: "provider", type: "text", required: true },
    { name: "model", type: "text", required: true },
    { name: "input_tokens", type: "number", min: 0, onlyInt: true },
    { name: "output_tokens", type: "number", min: 0, onlyInt: true },
    { name: "estimated_cost", type: "number", min: 0 },
    { name: "timestamp", type: "date", required: true },
    ...timestamps(),
  ], ADMIN_READ_RULES, {
    bareName: "ai_usage",
    indexes: ['CREATE INDEX idx_ai_usage_client_task ON ai_usage (client, task, timestamp)'],
  });


  // ---------- PHASE 4: AI content engine ----------
  // Every content artifact is written by the content worker or by trusted
  // server actions through the admin client after tenant authorization.
  // Users can read rows of their own organization only.
  const autodates = () => [
    { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
  ];
  const CONTENT_TYPES = ["blog_article", "service_page", "location_page", "guide", "comparison", "faq_page", "existing_page_optimization"];

  await ensureCollection("articles", [
    ...tenantFields(),
    { name: "content_opportunity", type: "relation", maxSelect: 1, collectionId: rel("content_opportunities"), required: false, cascadeDelete: false },
    { name: "content_plan_item", type: "relation", maxSelect: 1, collectionId: rel("content_plan_items"), required: false, cascadeDelete: false },
    { name: "keyword", type: "relation", maxSelect: 1, collectionId: rel("keywords"), required: false, cascadeDelete: false },
    { name: "cluster", type: "relation", maxSelect: 1, collectionId: rel("topic_clusters"), required: false, cascadeDelete: false },
    { name: "existing_page", type: "relation", maxSelect: 1, collectionId: rel("website_pages"), required: false, cascadeDelete: false },
    { name: "content_type", type: "select", values: CONTENT_TYPES, maxSelect: 1, required: true },
    { name: "title", type: "text", max: 300 },
    { name: "slug", type: "text", max: 200 },
    { name: "excerpt", type: "text", max: 1000 },
    { name: "seo_title", type: "text", max: 200 },
    { name: "meta_description", type: "text", max: 400 },
    { name: "og_title", type: "text", max: 200 },
    { name: "og_description", type: "text", max: 400 },
    { name: "content", type: "editor", maxSize: 2000000 },
    { name: "content_format", type: "select", values: ["markdown"], maxSelect: 1 },
    { name: "existing_content", type: "editor", maxSize: 2000000 },
    { name: "status", type: "select", values: ["researching", "brief_ready", "outline_ready", "drafting", "draft", "qa", "needs_revision", "awaiting_approval", "approved", "rejected", "failed"], maxSelect: 1, required: true },
    { name: "primary_keyword", type: "text", max: 200 },
    { name: "secondary_keywords", type: "json" },
    { name: "target_location", type: "text", max: 200 },
    { name: "recommended_url", type: "text", max: 500 },
    { name: "featured_image", type: "text", max: 500 },
    { name: "canonical_url", type: "text", max: 500 },
    { name: "author", type: "text", max: 200 },
    { name: "language", type: "text", max: 20, required: true },
    { name: "brief", type: "json", maxSize: 500000 },
    { name: "outline", type: "json", maxSize: 500000 },
    { name: "structured_data", type: "json", maxSize: 200000 },
    { name: "qa_status", type: "select", values: ["pending", "PASS", "NEEDS_REVISION", "BLOCKED", "stale"], maxSelect: 1 },
    { name: "qa_score", type: "json" },
    { name: "qa_summary", type: "editor" },
    { name: "fact_check_status", type: "select", values: ["pending", "passed", "issues", "blocked", "stale"], maxSelect: 1 },
    { name: "flags", type: "json" },
    { name: "high_risk", type: "bool" },
    { name: "risk_categories", type: "json" },
    { name: "revision_cycles", type: "number", min: 0, onlyInt: true },
    { name: "current_version", type: "number", min: 0, onlyInt: true },
    { name: "generation_key", type: "text", max: 200 },
    { name: "generation_input", type: "json" },
    { name: "provenance", type: "json" },
    { name: "pipeline_state", type: "json" },
    { name: "approved_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    { name: "approved_at", type: "date", required: false },
    { name: "rejected_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    { name: "rejected_at", type: "date", required: false },
    { name: "rejection_reason", type: "text", max: 2000 },
    { name: "created_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    ...timestamps(),
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "articles",
    indexes: [
      "CREATE UNIQUE INDEX idx_articles_generation_key ON articles (generation_key) WHERE generation_key != ''",
      "CREATE INDEX idx_articles_website_status ON articles (website, status)",
      "CREATE INDEX idx_articles_client_status ON articles (client, status)",
    ],
  });

  await ensureCollection("article_versions", [
    ...tenantFields(),
    { name: "article", type: "relation", maxSelect: 1, collectionId: rel("articles"), required: true, cascadeDelete: true },
    { name: "version", type: "number", required: true, min: 1, onlyInt: true },
    { name: "title", type: "text", max: 300 },
    { name: "content", type: "editor", maxSize: 2000000 },
    { name: "seo_title", type: "text", max: 200 },
    { name: "meta_description", type: "text", max: 400 },
    { name: "excerpt", type: "text", max: 1000 },
    { name: "slug", type: "text", max: 200 },
    { name: "change_type", type: "select", values: ["ai_generation", "ai_revision", "manual_edit", "restore"], maxSelect: 1, required: true },
    { name: "change_reason", type: "text", max: 2000 },
    { name: "created_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    { name: "created_by_label", type: "text", max: 200 },
    { name: "created_at", type: "date", required: false },
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "article_versions",
    indexes: ["CREATE UNIQUE INDEX idx_article_versions_article_version ON article_versions (article, version)"],
  });

  await ensureCollection("content_jobs", [
    ...tenantFields(),
    { name: "article", type: "relation", maxSelect: 1, collectionId: rel("articles"), required: true, cascadeDelete: true },
    { name: "opportunity", type: "relation", maxSelect: 1, collectionId: rel("content_opportunities"), required: false, cascadeDelete: false },
    { name: "plan_item", type: "relation", maxSelect: 1, collectionId: rel("content_plan_items"), required: false, cascadeDelete: false },
    { name: "mode", type: "select", values: ["generate", "continue", "revision", "recheck"], maxSelect: 1, required: true },
    { name: "status", type: "select", values: ["queued", "running", "completed", "failed", "cancelled"], maxSelect: 1, required: true },
    { name: "step", type: "text" },
    { name: "progress", type: "number", min: 0, max: 100 },
    { name: "configuration", type: "json" },
    { name: "revision_instruction", type: "text", max: 2000 },
    { name: "attempt", type: "number", min: 0, onlyInt: true },
    { name: "started_at", type: "date", required: false },
    { name: "completed_at", type: "date", required: false },
    { name: "error", type: "editor" },
    { name: "error_code", type: "text", max: 100 },
    { name: "triggered_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    ...timestamps(),
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "content_jobs",
    indexes: [
      "CREATE INDEX idx_content_jobs_status ON content_jobs (status, created_at)",
      "CREATE UNIQUE INDEX idx_content_jobs_active_article ON content_jobs (article) WHERE status IN ('queued', 'running')",
    ],
  });

  await ensureCollection("research_sources", [
    ...tenantFields(),
    { name: "article", type: "relation", maxSelect: 1, collectionId: rel("articles"), required: true, cascadeDelete: true },
    { name: "url", type: "text", required: true, max: 2000 },
    { name: "normalized_url", type: "text", required: true, max: 2000 },
    { name: "title", type: "text", max: 500 },
    { name: "publisher", type: "text", max: 300 },
    { name: "source_type", type: "select", values: ["government", "official", "manufacturer", "academic", "institution", "industry", "news", "client_site", "blog", "other"], maxSelect: 1, required: true },
    { name: "retrieved_at", type: "date", required: false },
    { name: "relevance", type: "number", min: 0, max: 1 },
    { name: "quality", type: "number", min: 0, max: 1 },
    { name: "notes", type: "text", max: 2000 },
    { name: "excerpt", type: "editor", maxSize: 200000 },
    { name: "query", type: "text", max: 500 },
    { name: "verified_access", type: "bool" },
    { name: "http_status", type: "number" },
    { name: "provider", type: "text", max: 100 },
    { name: "created_at", type: "date", required: false },
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "research_sources",
    indexes: ["CREATE UNIQUE INDEX idx_research_sources_article_url ON research_sources (article, normalized_url)"],
  });

  await ensureCollection("article_research", [
    ...tenantFields(),
    { name: "article", type: "relation", maxSelect: 1, collectionId: rel("articles"), required: true, cascadeDelete: true },
    { name: "search_intent", type: "text", max: 2000 },
    { name: "audience", type: "text", max: 2000 },
    { name: "questions", type: "json" },
    { name: "facts", type: "json", maxSize: 500000 },
    { name: "source_ids", type: "json" },
    { name: "existing_content_summary", type: "editor" },
    { name: "internal_link_candidates", type: "json" },
    { name: "risks", type: "json" },
    { name: "do_not_claim", type: "json" },
    { name: "content_gaps", type: "json" },
    { name: "recommended_angle", type: "editor" },
    { name: "research_status", type: "select", values: ["completed", "limited", "research_required"], maxSelect: 1 },
    { name: "research_notes", type: "text", max: 2000 },
    ...timestamps(),
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "article_research",
    indexes: ["CREATE UNIQUE INDEX idx_article_research_article ON article_research (article)"],
  });

  await ensureCollection("article_claims", [
    ...tenantFields(),
    { name: "article", type: "relation", maxSelect: 1, collectionId: rel("articles"), required: true, cascadeDelete: true },
    { name: "version", type: "number", min: 0, onlyInt: true },
    { name: "claim", type: "text", required: true, max: 2000 },
    { name: "claim_type", type: "select", values: ["business", "external", "statistic", "product", "medical", "financial", "legal", "general"], maxSelect: 1, required: true },
    { name: "source", type: "text", max: 500 },
    { name: "source_id", type: "text", max: 100 },
    { name: "evidence_ids", type: "json" },
    { name: "verification_status", type: "select", values: ["PENDING", "VERIFIED", "SUPPORTED", "UNVERIFIED", "CONTRADICTED", "NOT_REQUIRED"], maxSelect: 1, required: true },
    { name: "risk_level", type: "select", values: ["low", "medium", "high"], maxSelect: 1, required: true },
    { name: "action", type: "select", values: ["approve", "flag", "rewrite", "remove"], maxSelect: 1 },
    { name: "notes", type: "text", max: 2000 },
    { name: "created_at", type: "date", required: false },
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "article_claims",
    indexes: ["CREATE INDEX idx_article_claims_article_version ON article_claims (article, version)"],
  });

  await ensureCollection("article_internal_links", [
    ...tenantFields(),
    { name: "article", type: "relation", maxSelect: 1, collectionId: rel("articles"), required: true, cascadeDelete: true },
    { name: "version", type: "number", min: 0, onlyInt: true },
    { name: "destination_page", type: "relation", maxSelect: 1, collectionId: rel("website_pages"), required: false, cascadeDelete: false },
    { name: "destination_url", type: "text", required: true, max: 2000 },
    { name: "anchor_text", type: "text", max: 300 },
    { name: "reason", type: "text", max: 1000 },
    { name: "status", type: "select", values: ["inserted", "recommended", "removed"], maxSelect: 1, required: true },
    { name: "created_at", type: "date", required: false },
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "article_internal_links",
    indexes: ["CREATE INDEX idx_article_links_article_version ON article_internal_links (article, version)"],
  });

  await ensureCollection("article_qa_reports", [
    ...tenantFields(),
    { name: "article", type: "relation", maxSelect: 1, collectionId: rel("articles"), required: true, cascadeDelete: true },
    { name: "version", type: "number", min: 0, onlyInt: true },
    { name: "cycle", type: "number", min: 0, onlyInt: true },
    { name: "status", type: "select", values: ["PASS", "NEEDS_REVISION", "BLOCKED"], maxSelect: 1, required: true },
    { name: "score", type: "json" },
    { name: "checks", type: "json", maxSize: 500000 },
    { name: "issues", type: "json", maxSize: 500000 },
    { name: "flags", type: "json" },
    { name: "summary", type: "editor" },
    { name: "created_at", type: "date", required: false },
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "article_qa_reports",
    indexes: ["CREATE INDEX idx_article_qa_article_version ON article_qa_reports (article, version)"],
  });

  await ensureCollection("articles", [
    { name: "research", type: "relation", maxSelect: 1, collectionId: rel("article_research"), required: false, cascadeDelete: false },
  ], ADMIN_READ_RULES, { bareName: "articles" });

  // ai_usage gains content-engine tasks + article/job attribution. A number
  // field cannot hold null, so cost_status states whether estimated_cost is real.
  await ensureCollection("ai_usage", [
    { name: "article", type: "relation", maxSelect: 1, collectionId: rel("articles"), required: false, cascadeDelete: false },
    { name: "content_job", type: "relation", maxSelect: 1, collectionId: rel("content_jobs"), required: false, cascadeDelete: false },
    { name: "cost_status", type: "select", values: ["calculated", "pricing_not_configured"], maxSelect: 1 },
  ], ADMIN_READ_RULES, { bareName: "ai_usage" });
  await ensureSelectValues("ai_usage", "task", ["research_analysis", "brief_generation", "outline_generation", "draft_generation", "claim_extraction", "fact_check", "qa", "revision", "metadata"]);

  // --- users auth collection: add fields + tighten rules ---
  const usersCol = await getCollection(USERS_COLL);
  usersCol.fields = [...usersCol.fields.filter((f) =>
    !["name", "organization", "role", "status"].includes(f.name)
  ), ...[
    { name: "name", type: "text" },
    { name: "organization", type: "relation", maxSelect: 1, collectionId: rel("organizations"), required: false },
    { name: "role", type: "select", values: ["super_admin", "admin", "client", "editor", "viewer"], maxSelect: 1, required: true },
    { name: "status", type: "select", values: ["active", "disabled"], maxSelect: 1, required: true },
  ]];
  usersCol.listRule = '@request.auth.organization.id = organization.id || @request.auth.id = id';
  usersCol.viewRule = '@request.auth.organization.id = organization.id || @request.auth.id = id';
  usersCol.createRule = '@request.auth.organization.id != "" && @request.auth.role = "admin"';
  usersCol.updateRule = '@request.auth.id = id || (@request.auth.organization.id = organization.id && @request.auth.role = "admin")';
  usersCol.deleteRule = null;
  await patchCollection(USERS_COLL, usersCol);
  console.log(`✓ users fields+rules updated (${USERS_COLL})`);

  console.log("\n✅ Schema ready.");
  console.log(`   organizations:   ${REF.organizations}`);
  console.log(`   clients:         ${REF.clients}`);
  console.log(`   websites:        ${REF.websites}`);
  console.log(`   activity_logs:   ${REF.activity_logs}`);
  console.log(`   website_pages:   ${REF.website_pages}`);
  console.log(`   crawl_jobs:      ${REF.crawl_jobs}`);
  console.log(`   seo_issues:      ${REF.seo_issues}`);
  console.log(`   website_snapshots: ${REF.website_snapshots}`);
  console.log(`   page_links:      ${REF.page_links}`);
  console.log(`   website_changes: ${REF.website_changes}`);
  console.log(`   business_facts:  ${REF.business_facts}`);
  console.log(`   keywords:        ${REF.keywords}`);
  console.log(`   topic_clusters:  ${REF.topic_clusters}`);
  console.log(`   keyword_page_mappings: ${REF.keyword_page_mappings}`);
  console.log(`   content_opportunities: ${REF.content_opportunities}`);
  console.log(`   cannibalization_issues: ${REF.cannibalization_issues}`);
  console.log(`   content_plans:   ${REF.content_plans}`);
  console.log(`   content_plan_items: ${REF.content_plan_items}`);
  console.log(`   strategy_jobs:   ${REF.strategy_jobs}`);
  console.log(`   strategy_versions: ${REF.strategy_versions}`);
  console.log(`   ai_usage:        ${REF.ai_usage}`);
  for (const name of ["articles", "article_versions", "content_jobs", "research_sources", "article_research", "article_claims", "article_internal_links", "article_qa_reports"]) console.log(`   ${name}: ${REF[name]}`);
  console.log(`   PB_URL: ${PB_URL}`);
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });