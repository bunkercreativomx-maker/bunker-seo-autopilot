#!/usr/bin/env node
/**
 * Bunker SEO Autopilot — PocketBase schema bootstrap (Phases 1–3).
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
  console.log(`   PB_URL: ${PB_URL}`);
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });