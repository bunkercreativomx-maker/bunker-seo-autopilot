#!/usr/bin/env node
/**
 * Bunker SEO Autopilot — PocketBase schema bootstrap (Phases 1–7).
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
    createRule: 'organization.id = @request.auth.organization.id && @request.auth.role != "viewer" && @request.auth.role != "client"',
    // The tenant of an existing client can never be changed (no org hopping).
    updateRule: 'organization.id = @request.auth.organization.id && @request.auth.role != "viewer" && @request.auth.role != "client" && @request.body.organization:isset = false',
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
    // A website must belong to a client of the SAME organization.
    createRule: 'organization.id = @request.auth.organization.id && client.organization.id = @request.auth.organization.id && @request.auth.role != "viewer" && @request.auth.role != "client"',
    // Tenant fields are immutable once created (no re-pointing to another org/client).
    updateRule: 'organization.id = @request.auth.organization.id && @request.auth.role != "viewer" && @request.auth.role != "client" && @request.body.organization:isset = false && @request.body.client:isset = false',
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
    // The website/client must belong to the caller's organization and to each
    // other; the job is always attributed to the caller.
    createRule: 'organization.id = @request.auth.organization.id && website.organization.id = @request.auth.organization.id && client.id = website.client.id && triggered_by = @request.auth.id && status = "queued" && @request.auth.role != "viewer" && @request.auth.role != "client"',
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
    createRule: 'organization.id = @request.auth.organization.id && client.organization.id = organization.id && website.organization.id = organization.id && website.client.id = client.id && triggered_by.id = @request.auth.id && status = "queued" && progress = 0 && @request.auth.role != "viewer" && @request.auth.role != "client"',
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

  // ---------- PHASE 5: publishing engine ----------
  // Publishing state is written ONLY by pb_hooks (user-scoped endpoints) and
  // the bunker-seo-publisher worker (superuser). Users read their org's rows;
  // secrets live in hidden fields that the REST API never returns to users.
  await ensureSelectValues("articles", "status", ["publish_queued", "publishing", "published", "publish_failed", "unpublished"]);
  await ensureCollection("articles", [
    { name: "approved_version", type: "number", min: 0, onlyInt: true },
    { name: "approved_hash", type: "text", max: 100 },
    { name: "approved_snapshot", type: "json", maxSize: 2500000 },
    { name: "published_at", type: "date", required: false },
    { name: "published_version", type: "number", min: 0, onlyInt: true },
  ], ADMIN_READ_RULES, { bareName: "articles" });

  // Website publishing configuration (non-secret). Users can never write these
  // fields directly (create/update rules below); only the publishing hook does.
  const P5_WEBSITE_FIELDS = [
    { name: "publishing_enabled", type: "bool" },
    { name: "publisher_type", type: "select", values: ["pocketbase_cms", "nextjs_api", "webhook", "wordpress"], maxSelect: 1 },
    { name: "publishing_mode", type: "select", values: ["manual", "approval", "autopilot_future"], maxSelect: 1 },
    { name: "publishing_environment", type: "select", values: ["staging", "production"], maxSelect: 1 },
    { name: "base_url", type: "text", max: 500 },
    { name: "blog_path", type: "text", max: 200 },
    { name: "api_endpoint", type: "text", max: 500 },
    { name: "allowed_domains", type: "json" },
    { name: "connection_status", type: "select", values: ["not_configured", "connected", "failed", "unauthorized", "invalid_response", "timeout"], maxSelect: 1 },
    { name: "last_connection_test", type: "date", required: false },
    { name: "last_connection_error", type: "text", max: 500 },
    { name: "publication_requires_approval", type: "bool" },
    { name: "auto_revalidate", type: "bool" },
    { name: "publishing_configuration", type: "json" },
    { name: "last_publication_at", type: "date", required: false },
  ];
  // Phase 6: analytics thresholds are hook-written only (same lock as P5 fields).
  P5_WEBSITE_FIELDS.push({ name: "analytics_settings", type: "json" });
  const lockP5 = P5_WEBSITE_FIELDS.map((f) => `@request.body.${f.name}:isset = false`).join(" && ");
  await ensureCollection("websites", P5_WEBSITE_FIELDS, {
    listRule: 'organization.id = @request.auth.organization.id',
    viewRule: 'organization.id = @request.auth.organization.id',
    createRule: `organization.id = @request.auth.organization.id && client.organization.id = @request.auth.organization.id && @request.auth.role != "viewer" && @request.auth.role != "client" && ${lockP5}`,
    updateRule: `organization.id = @request.auth.organization.id && @request.auth.role != "viewer" && @request.auth.role != "client" && @request.body.organization:isset = false && @request.body.client:isset = false && ${lockP5}`,
    deleteRule: null,
  });

  await ensureCollection("integrations", [
    ...tenantFields(),
    { name: "kind", type: "select", values: ["publishing"], maxSelect: 1, required: true },
    { name: "publisher_type", type: "select", values: ["pocketbase_cms", "nextjs_api", "webhook", "wordpress"], maxSelect: 1 },
    { name: "status", type: "select", values: ["active", "disabled"], maxSelect: 1, required: true },
    // Encrypted at rest (AES-256-GCM, key outside the DB). Hidden: never
    // returned by the REST API to users; only the publisher worker decrypts.
    { name: "secret_encrypted", type: "text", max: 4000, hidden: true },
    { name: "previous_secret_encrypted", type: "text", max: 4000, hidden: true },
    { name: "previous_secret_valid_until", type: "date", required: false },
    { name: "secret_last4", type: "text", max: 8 },
    { name: "secret_set_at", type: "date", required: false },
    { name: "username", type: "text", max: 200 },
    { name: "config", type: "json" },
    { name: "updated_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    ...timestamps(),
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "integrations",
    indexes: ["CREATE UNIQUE INDEX idx_integrations_website_kind ON integrations (website, kind)"],
  });

  await ensureCollection("article_publications", [
    ...tenantFields(),
    { name: "article", type: "relation", maxSelect: 1, collectionId: rel("articles"), required: true, cascadeDelete: false },
    { name: "article_version", type: "number", min: 0, onlyInt: true },
    { name: "version_hash", type: "text", max: 100 },
    { name: "publisher_type", type: "select", values: ["pocketbase_cms", "nextjs_api", "webhook", "wordpress"], maxSelect: 1 },
    { name: "remote_id", type: "text", max: 300 },
    { name: "public_url", type: "text", max: 1000 },
    { name: "slug", type: "text", max: 200 },
    { name: "status", type: "select", values: ["publishing", "verification_required", "published", "unpublished", "failed"], maxSelect: 1, required: true },
    { name: "epoch", type: "number", min: 0, onlyInt: true },
    { name: "published_at", type: "date", required: false },
    { name: "published_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    { name: "last_verified_at", type: "date", required: false },
    { name: "unpublished_at", type: "date", required: false },
    { name: "metadata", type: "json" },
    ...timestamps(),
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "article_publications",
    indexes: [
      "CREATE UNIQUE INDEX idx_publications_article_website ON article_publications (article, website)",
      "CREATE INDEX idx_publications_website_slug ON article_publications (website, slug)",
    ],
  });

  await ensureCollection("publish_jobs", [
    ...tenantFields(),
    { name: "article", type: "relation", maxSelect: 1, collectionId: rel("articles"), required: false, cascadeDelete: false },
    { name: "publication", type: "relation", maxSelect: 1, collectionId: rel("article_publications"), required: false, cascadeDelete: false },
    { name: "operation", type: "select", values: ["publish", "update", "unpublish", "rollback", "republish", "verify", "test_connection"], maxSelect: 1, required: true },
    { name: "publisher_type", type: "select", values: ["pocketbase_cms", "nextjs_api", "webhook", "wordpress"], maxSelect: 1 },
    { name: "status", type: "select", values: ["queued", "validating", "publishing", "verifying", "published", "failed", "cancelled", "unpublishing", "unpublished", "verification_required", "completed"], maxSelect: 1, required: true },
    { name: "article_version", type: "number", min: 0, onlyInt: true },
    { name: "version_hash", type: "text", max: 100 },
    { name: "target_version", type: "number", min: 0, onlyInt: true },
    { name: "attempt", type: "number", min: 0, onlyInt: true },
    { name: "max_attempts", type: "number", min: 1, onlyInt: true },
    { name: "next_attempt_at", type: "date", required: false },
    { name: "requested_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    { name: "requested_at", type: "date", required: false },
    { name: "started_at", type: "date", required: false },
    { name: "completed_at", type: "date", required: false },
    { name: "public_url", type: "text", max: 1000 },
    { name: "remote_id", type: "text", max: 300 },
    { name: "response_summary", type: "json" },
    { name: "error_code", type: "text", max: 100 },
    { name: "error_message", type: "text", max: 1000 },
    { name: "idempotency_key", type: "text", max: 200, required: true },
    { name: "acknowledge_high_risk", type: "bool" },
    ...timestamps(),
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "publish_jobs",
    indexes: [
      "CREATE INDEX idx_publish_jobs_status ON publish_jobs (status, created_at)",
      "CREATE UNIQUE INDEX idx_publish_jobs_idempotency ON publish_jobs (idempotency_key) WHERE status NOT IN ('failed', 'cancelled')",
      "CREATE UNIQUE INDEX idx_publish_jobs_active_article ON publish_jobs (article) WHERE article != '' AND status IN ('queued', 'validating', 'publishing', 'verifying', 'unpublishing')",
    ],
  });

  await ensureCollection("publication_events", [
    ...tenantFields(),
    { name: "publication", type: "relation", maxSelect: 1, collectionId: rel("article_publications"), required: false, cascadeDelete: false },
    { name: "article", type: "relation", maxSelect: 1, collectionId: rel("articles"), required: true, cascadeDelete: false },
    { name: "job", type: "relation", maxSelect: 1, collectionId: rel("publish_jobs"), required: false, cascadeDelete: false },
    { name: "version", type: "number", min: 0, onlyInt: true },
    { name: "operation", type: "select", values: ["publish", "update", "verify", "unpublish", "republish", "rollback"], maxSelect: 1, required: true },
    { name: "status", type: "select", values: ["requested", "success", "failed", "verification_required"], maxSelect: 1, required: true },
    { name: "remote_id", type: "text", max: 300 },
    { name: "public_url", type: "text", max: 1000 },
    { name: "actor", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    { name: "details", type: "json", maxSize: 2500000 },
    { name: "created_at", type: "date", required: false },
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "publication_events",
    indexes: ["CREATE INDEX idx_publication_events_article ON publication_events (article, created_at)"],
  });

  // PUBLIC content model (PocketBase CMS mode). Anonymous visitors may read
  // ONLY published rows of the website they name (?website=<id>). Only safe
  // public fields are visible; tenant/audit links are hidden fields that the
  // REST API neither returns nor lets guests filter on. Drafts, research,
  // claims, QA, AI usage, business facts and notes never enter this table.
  const PUBLIC_RULE = 'status = "published" && website = @request.query.website';
  await ensureCollection("published_content", [
    { name: "organization", type: "relation", maxSelect: 1, collectionId: rel("organizations"), required: true, cascadeDelete: false, hidden: true },
    { name: "client", type: "relation", maxSelect: 1, collectionId: rel("clients"), required: true, cascadeDelete: false, hidden: true },
    { name: "website", type: "relation", maxSelect: 1, collectionId: rel("websites"), required: true, cascadeDelete: true },
    { name: "publication", type: "relation", maxSelect: 1, collectionId: rel("article_publications"), required: true, cascadeDelete: true, hidden: true },
    { name: "article", type: "relation", maxSelect: 1, collectionId: rel("articles"), required: true, cascadeDelete: false, hidden: true },
    { name: "article_version", type: "number", min: 0, onlyInt: true, hidden: true },
    { name: "status", type: "select", values: ["published", "unpublished"], maxSelect: 1, required: true },
    { name: "title", type: "text", max: 300 },
    { name: "slug", type: "text", max: 200, required: true },
    { name: "excerpt", type: "text", max: 1000 },
    { name: "content", type: "editor", maxSize: 2000000 },
    { name: "content_format", type: "select", values: ["markdown"], maxSelect: 1 },
    { name: "featured_image", type: "text", max: 1000 },
    { name: "seo_title", type: "text", max: 200 },
    { name: "meta_description", type: "text", max: 400 },
    { name: "canonical_url", type: "text", max: 1000 },
    { name: "og_title", type: "text", max: 200 },
    { name: "og_description", type: "text", max: 400 },
    { name: "schema", type: "json", maxSize: 200000 },
    { name: "language", type: "text", max: 20 },
    { name: "content_type", type: "text", max: 50 },
    { name: "published_at", type: "date", required: false },
    { name: "updated_at", type: "date", required: false },
    { name: "author_public_name", type: "text", max: 200 },
    { name: "category", type: "text", max: 200 },
    { name: "tags", type: "json" },
    { name: "revision", type: "text", max: 64 },
  ], { listRule: PUBLIC_RULE, viewRule: PUBLIC_RULE, createRule: null, updateRule: null, deleteRule: null }, {
    bareName: "published_content",
    indexes: [
      "CREATE UNIQUE INDEX idx_published_content_publication ON published_content (publication)",
      "CREATE INDEX idx_published_content_website_slug ON published_content (website, slug, status)",
    ],
  });

  // Website-specific taxonomy (architecture-ready; never shared across websites).
  await ensureCollection("content_taxonomies", [
    ...tenantFields(),
    { name: "kind", type: "select", values: ["category", "tag"], maxSelect: 1, required: true },
    { name: "name", type: "text", required: true, max: 200 },
    { name: "slug", type: "text", required: true, max: 200 },
    ...timestamps(),
  ], ADMIN_READ_RULES, {
    bareName: "content_taxonomies",
    indexes: ["CREATE UNIQUE INDEX idx_taxonomies_website_kind_slug ON content_taxonomies (website, kind, slug)"],
  });

  // ================================================================ Phase 6
  // Search Console analytics. Every collection is written ONLY by pb_hooks or
  // the bunker-seo-analytics worker (superuser); users read their own org.
  // OAuth material (refresh token, state nonces) lives in hidden fields that
  // the REST API never returns.
  const siteOrg = () => [
    { name: "organization", type: "relation", maxSelect: 1, collectionId: rel("organizations"), required: true, cascadeDelete: false },
    { name: "website", type: "relation", maxSelect: 1, collectionId: rel("websites"), required: true, cascadeDelete: true },
  ];

  await ensureCollection("gsc_connections", [
    { name: "organization", type: "relation", maxSelect: 1, collectionId: rel("organizations"), required: true, cascadeDelete: false },
    { name: "connected_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    { name: "google_account_email", type: "text", max: 320 },
    { name: "google_sub", type: "text", max: 100, hidden: true },
    { name: "encrypted_refresh_token", type: "text", max: 4000, hidden: true },
    { name: "scopes", type: "json" },
    { name: "status", type: "select", values: ["connected", "expired", "revoked", "error", "reauth_required", "disconnected"], maxSelect: 1, required: true },
    { name: "last_refresh_at", type: "date", required: false },
    { name: "last_error", type: "text", max: 500 },
    { name: "disconnected_at", type: "date", required: false },
    ...timestamps(),
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "gsc_connections",
    indexes: ["CREATE UNIQUE INDEX idx_gsc_connections_org_sub ON gsc_connections (organization, google_sub) WHERE google_sub != ''"],
  });

  await ensureCollection("gsc_properties", [
    { name: "organization", type: "relation", maxSelect: 1, collectionId: rel("organizations"), required: true, cascadeDelete: false },
    { name: "connection", type: "relation", maxSelect: 1, collectionId: rel("gsc_connections"), required: true, cascadeDelete: true },
    { name: "website", type: "relation", maxSelect: 1, collectionId: rel("websites"), required: false, cascadeDelete: false },
    { name: "site_url", type: "text", max: 500, required: true },
    { name: "property_type", type: "select", values: ["domain", "url_prefix"], maxSelect: 1, required: true },
    { name: "permission_level", type: "text", max: 50 },
    { name: "status", type: "select", values: ["available", "active", "access_lost", "disconnected"], maxSelect: 1, required: true },
    { name: "selected", type: "bool" },
    { name: "match_status", type: "select", values: ["matched", "possible_match", "mismatch"], maxSelect: 1 },
    { name: "selected_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    { name: "selected_at", type: "date", required: false },
    { name: "last_verified_at", type: "date", required: false },
    // Search Console dates are PT calendar days kept verbatim (YYYY-MM-DD).
    { name: "latest_final_date", type: "text", max: 10 },
    { name: "first_data_date", type: "text", max: 10 },
    { name: "last_synced_date", type: "text", max: 10 },
    { name: "source_timezone", type: "text", max: 60 },
    { name: "last_sync_at", type: "date", required: false },
    { name: "last_sync_status", type: "text", max: 40 },
    { name: "consecutive_failures", type: "number", min: 0, onlyInt: true },
    ...timestamps(),
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "gsc_properties",
    indexes: [
      "CREATE UNIQUE INDEX idx_gsc_properties_conn_site ON gsc_properties (connection, site_url)",
      "CREATE UNIQUE INDEX idx_gsc_properties_selected_website ON gsc_properties (website) WHERE selected = TRUE AND website != ''",
      "CREATE INDEX idx_gsc_properties_org ON gsc_properties (organization, status)",
    ],
  });

  await ensureCollection("gsc_oauth_states", [
    { name: "organization", type: "relation", maxSelect: 1, collectionId: rel("organizations"), required: true, cascadeDelete: true },
    { name: "user", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: true, cascadeDelete: true },
    { name: "website", type: "relation", maxSelect: 1, collectionId: rel("websites"), required: true, cascadeDelete: true },
    { name: "connection", type: "text", max: 15 },
    { name: "state_hash", type: "text", max: 64, required: true, hidden: true },
    { name: "expires_at", type: "date", required: true },
    { name: "used_at", type: "date", required: false },
    ...timestamps(),
  ], { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null }, {
    bareName: "gsc_oauth_states",
    indexes: ["CREATE UNIQUE INDEX idx_gsc_oauth_state_hash ON gsc_oauth_states (state_hash)"],
  });

  await ensureCollection("gsc_sync_jobs", [
    ...siteOrg(),
    { name: "property", type: "relation", maxSelect: 1, collectionId: rel("gsc_properties"), required: true, cascadeDelete: false },
    { name: "status", type: "select", values: ["queued", "running", "completed", "completed_with_warnings", "failed", "cancelled"], maxSelect: 1, required: true },
    { name: "sync_type", type: "select", values: ["initial", "manual", "daily", "backfill"], maxSelect: 1, required: true },
    { name: "range_label", type: "text", max: 20 },
    { name: "search_type", type: "text", max: 20 },
    { name: "data_state", type: "text", max: 10 },
    { name: "start_date", type: "text", max: 10 },
    { name: "end_date", type: "text", max: 10 },
    { name: "step", type: "text", max: 200 },
    { name: "progress", type: "number", min: 0, max: 100 },
    { name: "rows_requested", type: "number", min: 0, onlyInt: true },
    { name: "rows_received", type: "number", min: 0, onlyInt: true },
    { name: "rows_stored", type: "number", min: 0, onlyInt: true },
    { name: "api_requests", type: "number", min: 0, onlyInt: true },
    { name: "pagination_completed", type: "bool" },
    { name: "datasets", type: "json" },
    { name: "warnings", type: "json" },
    { name: "attempt", type: "number", min: 0, onlyInt: true },
    { name: "dedupe_key", type: "text", max: 200 },
    { name: "started_at", type: "date", required: false },
    { name: "completed_at", type: "date", required: false },
    { name: "error_code", type: "text", max: 80 },
    { name: "error_message", type: "text", max: 1000 },
    { name: "triggered_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    ...timestamps(),
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "gsc_sync_jobs",
    indexes: [
      "CREATE INDEX idx_gsc_jobs_status ON gsc_sync_jobs (status, created_at)",
      "CREATE INDEX idx_gsc_jobs_website ON gsc_sync_jobs (website, created_at)",
      "CREATE UNIQUE INDEX idx_gsc_jobs_active_property ON gsc_sync_jobs (property) WHERE status IN ('queued', 'running')",
      "CREATE UNIQUE INDEX idx_gsc_jobs_dedupe ON gsc_sync_jobs (dedupe_key) WHERE dedupe_key != ''",
    ],
  });

  // Metric rows: only values returned by Google (clicks, impressions, ctr,
  // position). `date` = Search Console source_date (PT day), stored verbatim.
  const metricFields = () => [
    { name: "clicks", type: "number", min: 0 },
    { name: "impressions", type: "number", min: 0 },
    { name: "ctr", type: "number", min: 0 },
    { name: "position", type: "number", min: 0 },
    { name: "search_type", type: "text", max: 20, required: true },
    { name: "synced_at", type: "date", required: false },
  ];
  const metricBase = () => [
    ...siteOrg(),
    { name: "property", type: "relation", maxSelect: 1, collectionId: rel("gsc_properties"), required: true, cascadeDelete: false },
    { name: "date", type: "text", max: 10, required: true },
  ];
  await ensureCollection("gsc_site_daily", [
    ...metricBase(), ...metricFields(),
    { name: "data_state", type: "text", max: 10 },
  ], ADMIN_READ_RULES, {
    bareName: "gsc_site_daily",
    indexes: ["CREATE UNIQUE INDEX idx_gsc_site_unique ON gsc_site_daily (website, property, date, search_type)"],
  });
  await ensureCollection("gsc_page_daily", [
    ...metricBase(),
    { name: "page", type: "text", max: 2000, required: true },
    ...metricFields(),
  ], ADMIN_READ_RULES, {
    bareName: "gsc_page_daily",
    indexes: [
      "CREATE UNIQUE INDEX idx_gsc_page_unique ON gsc_page_daily (website, property, date, search_type, page)",
      "CREATE INDEX idx_gsc_page_website_page_date ON gsc_page_daily (website, page, date)",
    ],
  });
  await ensureCollection("gsc_query_daily", [
    ...metricBase(),
    { name: "query", type: "text", max: 1000, required: true },
    { name: "normalized_query", type: "text", max: 1000, required: true },
    ...metricFields(),
  ], ADMIN_READ_RULES, {
    bareName: "gsc_query_daily",
    indexes: [
      "CREATE UNIQUE INDEX idx_gsc_query_unique ON gsc_query_daily (website, property, date, search_type, query)",
      "CREATE INDEX idx_gsc_query_website_nq_date ON gsc_query_daily (website, normalized_query, date)",
    ],
  });
  await ensureCollection("gsc_query_page_daily", [
    ...metricBase(),
    { name: "query", type: "text", max: 1000, required: true },
    { name: "normalized_query", type: "text", max: 1000, required: true },
    { name: "page", type: "text", max: 2000, required: true },
    ...metricFields(),
  ], ADMIN_READ_RULES, {
    bareName: "gsc_query_page_daily",
    indexes: [
      "CREATE UNIQUE INDEX idx_gsc_qp_unique ON gsc_query_page_daily (website, property, date, search_type, query, page)",
      "CREATE INDEX idx_gsc_qp_website_nq_date ON gsc_query_page_daily (website, normalized_query, date)",
      "CREATE INDEX idx_gsc_qp_website_page_date ON gsc_query_page_daily (website, page, date)",
    ],
  });

  // Deterministic query labels (Phase 3 classifier + Phase 3 keyword mapping).
  await ensureCollection("gsc_query_labels", [
    ...siteOrg(),
    { name: "normalized_query", type: "text", max: 1000, required: true },
    { name: "query", type: "text", max: 1000 },
    { name: "mapping", type: "select", values: ["known_keyword", "related_variant", "new_query", "unmapped"], maxSelect: 1, required: true },
    { name: "keyword", type: "relation", maxSelect: 1, collectionId: rel("keywords"), required: false, cascadeDelete: false },
    { name: "mapped_page", type: "text", max: 2000 },
    { name: "intent", type: "text", max: 20 },
    { name: "brand", type: "select", values: ["branded", "non_branded", "unknown"], maxSelect: 1 },
    { name: "brand_override", type: "select", values: ["branded", "non_branded"], maxSelect: 1 },
    { name: "source", type: "text", max: 40 },
    { name: "labeled_at", type: "date", required: false },
  ], ADMIN_READ_RULES, {
    bareName: "gsc_query_labels",
    indexes: ["CREATE UNIQUE INDEX idx_gsc_labels_unique ON gsc_query_labels (website, normalized_query)"],
  });

  await ensureCollection("analytics_opportunities", [
    ...tenantFields(),
    { name: "type", type: "select", values: ["new_query", "high_impressions_low_ctr", "striking_distance", "content_decay", "growing_query", "growing_page", "position_decline", "impression_growth", "page_query_mismatch", "optimization_candidate", "potential_cannibalization"], maxSelect: 1, required: true },
    { name: "dedupe_key", type: "text", max: 64, required: true },
    { name: "query", type: "text", max: 1000 },
    { name: "page", type: "text", max: 2000 },
    { name: "current_period", type: "json" },
    { name: "previous_period", type: "json" },
    { name: "evidence", type: "json", required: true },
    { name: "reason", type: "text", max: 2000 },
    { name: "priority", type: "select", values: ["high", "medium", "low"], maxSelect: 1, required: true },
    { name: "recommended_action", type: "text", max: 1000 },
    { name: "status", type: "select", values: ["new", "reviewed", "accepted", "ignored", "resolved"], maxSelect: 1, required: true },
    { name: "source", type: "text", max: 40, required: true },
    { name: "first_detected_at", type: "date", required: false },
    { name: "last_detected_at", type: "date", required: false },
    { name: "resolved_at", type: "date", required: false },
    { name: "detection_count", type: "number", min: 0, onlyInt: true },
    { name: "decided_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    { name: "decided_at", type: "date", required: false },
    { name: "decision_note", type: "text", max: 1000 },
    { name: "content_opportunity", type: "relation", maxSelect: 1, collectionId: rel("content_opportunities"), required: false, cascadeDelete: false },
    ...timestamps(),
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "analytics_opportunities",
    indexes: [
      "CREATE UNIQUE INDEX idx_analytics_opp_dedupe ON analytics_opportunities (website, dedupe_key)",
      "CREATE INDEX idx_analytics_opp_website_type_status ON analytics_opportunities (website, type, status)",
    ],
  });

  await ensureCollection("gsc_data_quality_flags", [
    ...siteOrg(),
    { name: "start_date", type: "text", max: 10, required: true },
    { name: "end_date", type: "text", max: 10, required: true },
    { name: "reason", type: "text", max: 500, required: true },
    { name: "exclude_from_opportunities", type: "bool" },
    { name: "active", type: "bool" },
    { name: "created_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    ...timestamps(),
  ], ADMIN_READ_RULES, { bareName: "gsc_data_quality_flags" });

  await ensureCollection("notifications", [
    { name: "organization", type: "relation", maxSelect: 1, collectionId: rel("organizations"), required: true, cascadeDelete: true },
    { name: "website", type: "relation", maxSelect: 1, collectionId: rel("websites"), required: false, cascadeDelete: true },
    { name: "kind", type: "text", max: 60, required: true },
    { name: "severity", type: "select", values: ["info", "warning", "critical"], maxSelect: 1, required: true },
    { name: "title", type: "text", max: 300, required: true },
    { name: "body", type: "text", max: 2000 },
    { name: "link", type: "text", max: 500 },
    { name: "dedupe_key", type: "text", max: 200, required: true },
    { name: "occurrences", type: "number", min: 0, onlyInt: true },
    { name: "read_at", type: "date", required: false },
    ...timestamps(),
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "notifications",
    indexes: ["CREATE UNIQUE INDEX idx_notifications_dedupe ON notifications (organization, dedupe_key)"],
  });


  // ================================================================ Phase 7
  // Autopilot orchestration. Every collection is written ONLY by pb_hooks
  // (user-scoped /api/bsa/autopilot/* endpoints) or the bunker-seo-autopilot
  // worker (superuser). Users read their own organization's rows.
  const AP_MODES = ["OFF", "OBSERVE", "SUPERVISED", "FULL_AUTO"]; // FULL_AUTO reserved, rejected by hooks (Phase 7)
  const AP_ACTIONS = ["CRAWL", "STRATEGY_REFRESH", "GENERATE_CONTENT", "RECHECK_CONTENT", "REQUEST_REVISION", "PUBLISH", "VERIFY_PUBLICATION", "UPDATE_PUBLICATION", "AUTO_PUBLISH", "CREATE_ANALYTICS_OPPORTUNITY", "NOTIFY_HUMAN", "WAIT"];
  const AP_RUN_STATUS = ["queued", "collecting_signals", "evaluating", "planning", "executing", "waiting_for_approval", "monitoring", "paused", "completed", "completed_with_warnings", "failed", "cancelled"];
  const AP_TRIGGERS = ["scheduled", "manual", "dry_run", "crawl_completed", "strategy_completed", "gsc_sync_completed", "article_approved", "article_ready", "article_rejected", "content_job_finished", "publication_completed", "publication_failed", "content_recheck_completed", "analytics_opportunity_created", "follow_up"];
  const AP_SIGNALS = ["TECHNICAL_ISSUE", "CONTENT_GAP", "NEW_CONTENT_OPPORTUNITY", "STRIKING_DISTANCE", "LOW_CTR", "CONTENT_DECAY", "NEW_QUERY", "PAGE_QUERY_MISMATCH", "POTENTIAL_CANNIBALIZATION", "GROWING_PAGE", "GROWING_QUERY", "PUBLICATION_FAILED", "GSC_CONNECTION_LOST", "STALE_CRAWL", "STALE_STRATEGY", "ARTICLE_NEEDS_REVIEW", "ARTICLE_APPROVED", "PUBLICATION_UNVERIFIED"];
  const AP_DECISIONS = ["NO_ACTION", "REFRESH_CRAWL", "REFRESH_STRATEGY", "CREATE_CONTENT", "OPTIMIZE_EXISTING_CONTENT", "REVIEW_METADATA", "INVESTIGATE_TECHNICAL_ISSUE", "WAIT_FOR_MORE_DATA", "PAUSE_INTEGRATION", "PUBLISH_APPROVED_ARTICLE", "VERIFY_PUBLICATION", "RECHECK_ARTICLE", "REQUEST_HUMAN_REVIEW", "MONITOR"];
  const AP_ACTION_STATUS = ["planned", "blocked", "waiting_for_approval", "queued", "running", "completed", "completed_with_warnings", "failed", "skipped", "cancelled"];
  const AP_PRIORITY = ["critical", "high", "medium", "low", "monitor"];
  const AP_ERROR_CLASS = ["TRANSIENT", "CONFIGURATION", "AUTH", "POLICY", "DATA", "CONTENT", "SECURITY", "UNKNOWN"];

  await ensureCollection("autopilot_policies", [
    ...tenantFields(),
    { name: "enabled", type: "bool" },
    { name: "mode", type: "select", values: AP_MODES, maxSelect: 1, required: true },
    { name: "paused", type: "bool" },
    { name: "paused_reason", type: "text", max: 500 },
    { name: "paused_at", type: "date", required: false },
    { name: "schedule", type: "select", values: ["daily", "weekly", "manual_only"], maxSelect: 1, required: true },
    { name: "allowed_actions", type: "json" },
    { name: "allowed_environments", type: "json" },
    { name: "max_actions_per_day", type: "number", min: 0, onlyInt: true },
    { name: "max_content_jobs_per_day", type: "number", min: 0, onlyInt: true },
    { name: "max_content_jobs_per_week", type: "number", min: 0, onlyInt: true },
    { name: "max_publications_per_week", type: "number", min: 0, onlyInt: true },
    { name: "max_revision_jobs_per_article", type: "number", min: 0, onlyInt: true },
    { name: "max_strategy_refresh_per_week", type: "number", min: 0, onlyInt: true },
    { name: "max_crawls_per_week", type: "number", min: 0, onlyInt: true },
    { name: "max_ai_budget_daily", type: "number", min: 0 },
    { name: "max_ai_budget_monthly", type: "number", min: 0 },
    { name: "max_ai_calls_daily", type: "number", min: 0, onlyInt: true },
    { name: "max_ai_tokens_daily", type: "number", min: 0, onlyInt: true },
    { name: "require_human_publish_approval", type: "bool" },
    { name: "publish_after_human_approval", type: "bool" },
    { name: "auto_pick_opportunities", type: "bool" },
    { name: "auto_publish_safe", type: "bool" },
    { name: "posts_per_month", type: "number", min: 0, max: 31, onlyInt: true },
    { name: "publish_after_approval_since", type: "date", required: false },
    { name: "pause_on_high_risk", type: "bool" },
    { name: "pause_on_fact_failure", type: "bool" },
    { name: "pause_on_integration_error", type: "bool" },
    { name: "cooldown_hours", type: "number", min: 0, onlyInt: true },
    { name: "optimization_cooldown_days", type: "number", min: 0, onlyInt: true },
    { name: "crawl_max_age_days", type: "number", min: 1, onlyInt: true },
    { name: "strategy_max_age_days", type: "number", min: 1, onlyInt: true },
    { name: "approval_reminder_days", type: "number", min: 1, onlyInt: true },
    { name: "timezone", type: "text", max: 60 },
    { name: "version", type: "number", min: 0, onlyInt: true },
    { name: "next_run_at", type: "date", required: false },
    { name: "last_run_at", type: "date", required: false },
    { name: "created_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    { name: "updated_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    ...timestamps(),
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "autopilot_policies",
    indexes: ["CREATE UNIQUE INDEX idx_autopilot_policies_website ON autopilot_policies (website)"],
  });

  // Organization kill switch (AUTOPILOT_PAUSED) — one row per organization.
  await ensureCollection("autopilot_controls", [
    { name: "organization", type: "relation", maxSelect: 1, collectionId: rel("organizations"), required: true, cascadeDelete: true },
    { name: "paused", type: "bool" },
    { name: "reason", type: "text", max: 500 },
    { name: "paused_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    { name: "paused_at", type: "date", required: false },
    { name: "resumed_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    { name: "resumed_at", type: "date", required: false },
    ...timestamps(),
    ...autodates(),
  ], {
    listRule: "organization.id = @request.auth.organization.id",
    viewRule: "organization.id = @request.auth.organization.id",
    createRule: null, updateRule: null, deleteRule: null,
  }, { bareName: "autopilot_controls", indexes: ["CREATE UNIQUE INDEX idx_autopilot_controls_org ON autopilot_controls (organization)"] });

  await ensureCollection("autopilot_runs", [
    ...tenantFields(),
    { name: "policy", type: "relation", maxSelect: 1, collectionId: rel("autopilot_policies"), required: false, cascadeDelete: false },
    { name: "trigger", type: "select", values: AP_TRIGGERS, maxSelect: 1, required: true },
    { name: "trigger_ref", type: "text", max: 200 },
    { name: "dry_run", type: "bool" },
    { name: "status", type: "select", values: AP_RUN_STATUS, maxSelect: 1, required: true },
    { name: "mode", type: "text", max: 20 },
    { name: "started_at", type: "date", required: false },
    { name: "completed_at", type: "date", required: false },
    { name: "current_step", type: "text", max: 200 },
    { name: "signal_count", type: "number", min: 0, onlyInt: true },
    { name: "decision_count", type: "number", min: 0, onlyInt: true },
    { name: "action_count", type: "number", min: 0, onlyInt: true },
    { name: "estimated_ai_cost", type: "number", min: 0 },
    { name: "actual_ai_cost", type: "number", min: 0 },
    { name: "ai_cost_status", type: "select", values: ["known", "unknown", "none"], maxSelect: 1 },
    { name: "ai_usage", type: "json" },
    { name: "policy_snapshot", type: "json" },
    { name: "result", type: "json" },
    { name: "reason", type: "text", max: 2000 },
    { name: "error_code", type: "text", max: 80 },
    { name: "error_message", type: "text", max: 1000 },
    { name: "parent_run", type: "text", max: 15 },
    { name: "follow_up_requested", type: "bool" },
    { name: "lease_owner", type: "text", max: 100 },
    { name: "lease_until", type: "date", required: false },
    { name: "requested_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    ...timestamps(),
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "autopilot_runs",
    indexes: [
      "CREATE INDEX idx_autopilot_runs_website ON autopilot_runs (website, created_at)",
      "CREATE INDEX idx_autopilot_runs_status ON autopilot_runs (status, created_at)",
      // Single active (hot) run per website; parked runs (waiting/monitoring) and dry runs excluded.
      "CREATE UNIQUE INDEX idx_autopilot_runs_active_website ON autopilot_runs (website) WHERE dry_run = FALSE AND status IN ('queued', 'collecting_signals', 'evaluating', 'planning', 'executing')",
    ],
  });

  await ensureCollection("autopilot_signals", [
    ...tenantFields(),
    { name: "source", type: "select", values: ["crawler", "strategy", "content", "publishing", "search_console", "manual", "system"], maxSelect: 1, required: true },
    { name: "source_record", type: "text", max: 200 },
    { name: "signal_type", type: "select", values: AP_SIGNALS, maxSelect: 1, required: true },
    { name: "evidence", type: "json" },
    { name: "strength", type: "number", min: 0, max: 1 },
    { name: "detected_at", type: "date", required: false },
    { name: "last_seen_at", type: "date", required: false },
    { name: "seen_count", type: "number", min: 0, onlyInt: true },
    { name: "expires_at", type: "date", required: false },
    { name: "status", type: "select", values: ["active", "resolved", "expired", "ignored", "snoozed"], maxSelect: 1, required: true },
    { name: "snoozed_until", type: "date", required: false },
    { name: "status_reason", type: "text", max: 500 },
    { name: "decided_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    { name: "dedup_key", type: "text", max: 300, required: true },
    { name: "last_run", type: "text", max: 15 },
    ...timestamps(),
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "autopilot_signals",
    indexes: [
      "CREATE UNIQUE INDEX idx_autopilot_signals_dedup ON autopilot_signals (website, dedup_key)",
      "CREATE INDEX idx_autopilot_signals_website_status ON autopilot_signals (website, status, signal_type)",
    ],
  });

  await ensureCollection("autopilot_decisions", [
    ...tenantFields(),
    { name: "run", type: "relation", maxSelect: 1, collectionId: rel("autopilot_runs"), required: true, cascadeDelete: false },
    { name: "signal", type: "text", max: 15 },
    { name: "decision_type", type: "select", values: AP_DECISIONS, maxSelect: 1, required: true },
    { name: "priority", type: "select", values: AP_PRIORITY, maxSelect: 1, required: true },
    { name: "score", type: "number" },
    { name: "evidence", type: "json" },
    { name: "reason", type: "text", max: 2000 },
    { name: "rule", type: "text", max: 200 },
    { name: "block_code", type: "text", max: 80 },
    { name: "planned_action", type: "json" },
    { name: "explanation", type: "text", max: 2000 },
    { name: "policy_snapshot", type: "json" },
    { name: "risk_level", type: "select", values: ["low", "medium", "high"], maxSelect: 1 },
    { name: "requires_approval", type: "bool" },
    { name: "status", type: "select", values: ["proposed", "planned", "executed", "skipped", "blocked", "dry_run"], maxSelect: 1, required: true },
    ...timestamps(),
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "autopilot_decisions",
    indexes: ["CREATE INDEX idx_autopilot_decisions_run ON autopilot_decisions (run, created_at)", "CREATE INDEX idx_autopilot_decisions_website ON autopilot_decisions (website, created_at)"],
  });

  await ensureCollection("autopilot_actions", [
    ...tenantFields(),
    { name: "run", type: "relation", maxSelect: 1, collectionId: rel("autopilot_runs"), required: true, cascadeDelete: false },
    { name: "decision", type: "relation", maxSelect: 1, collectionId: rel("autopilot_decisions"), required: false, cascadeDelete: false },
    { name: "action_type", type: "select", values: AP_ACTIONS, maxSelect: 1, required: true },
    { name: "target_type", type: "text", max: 60 },
    { name: "target_id", type: "text", max: 60 },
    { name: "status", type: "select", values: AP_ACTION_STATUS, maxSelect: 1, required: true },
    { name: "requires_approval", type: "bool" },
    { name: "approved_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    { name: "approved_at", type: "date", required: false },
    { name: "acting_user", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    { name: "article", type: "text", max: 15 },
    { name: "job_type", type: "text", max: 60 },
    { name: "job_id", type: "text", max: 60 },
    { name: "idempotency_key", type: "text", max: 300, required: true },
    { name: "attempt", type: "number", min: 0, onlyInt: true },
    { name: "max_attempts", type: "number", min: 1, onlyInt: true },
    { name: "policy_snapshot", type: "json" },
    { name: "started_at", type: "date", required: false },
    { name: "completed_at", type: "date", required: false },
    { name: "result", type: "json" },
    { name: "error_class", type: "select", values: AP_ERROR_CLASS, maxSelect: 1 },
    { name: "error_code", type: "text", max: 80 },
    { name: "error_message", type: "text", max: 1000 },
    ...timestamps(),
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "autopilot_actions",
    indexes: [
      "CREATE UNIQUE INDEX idx_autopilot_actions_idem ON autopilot_actions (idempotency_key) WHERE status NOT IN ('failed', 'cancelled', 'skipped')",
      "CREATE INDEX idx_autopilot_actions_run ON autopilot_actions (run, created_at)",
      "CREATE INDEX idx_autopilot_actions_website ON autopilot_actions (website, action_type, created_at)",
      "CREATE INDEX idx_autopilot_actions_target ON autopilot_actions (target_type, target_id)",
    ],
  });

  // Event-driven continuation queue: record hooks enqueue, the worker consumes.
  await ensureCollection("autopilot_triggers", [
    ...tenantFields(),
    { name: "trigger", type: "select", values: AP_TRIGGERS, maxSelect: 1, required: true },
    { name: "entity_type", type: "text", max: 60 },
    { name: "entity_id", type: "text", max: 60 },
    { name: "payload", type: "json" },
    { name: "dedup_key", type: "text", max: 300, required: true },
    { name: "status", type: "select", values: ["pending", "processed", "ignored", "merged"], maxSelect: 1, required: true },
    { name: "run", type: "text", max: 15 },
    { name: "processed_at", type: "date", required: false },
    { name: "note", type: "text", max: 500 },
    ...timestamps(),
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "autopilot_triggers",
    indexes: ["CREATE UNIQUE INDEX idx_autopilot_triggers_dedup ON autopilot_triggers (dedup_key)", "CREATE INDEX idx_autopilot_triggers_status ON autopilot_triggers (status, created_at)"],
  });

  // Human-readable run timeline (explainability).
  await ensureCollection("autopilot_run_events", [
    ...tenantFields(),
    { name: "run", type: "relation", maxSelect: 1, collectionId: rel("autopilot_runs"), required: true, cascadeDelete: false },
    { name: "action", type: "text", max: 15 },
    { name: "kind", type: "text", max: 60, required: true },
    { name: "message", type: "text", max: 1000 },
    { name: "details", type: "json" },
    { name: "at", type: "date", required: true },
    ...autodates(),
  ], ADMIN_READ_RULES, { bareName: "autopilot_run_events", indexes: ["CREATE INDEX idx_autopilot_run_events_run ON autopilot_run_events (run, at)"] });

  // Human tasks ("Needs Your Attention").
  await ensureCollection("autopilot_tasks", [
    ...tenantFields(),
    { name: "run", type: "text", max: 15 },
    { name: "action", type: "text", max: 15 },
    { name: "kind", type: "select", values: ["article_approval", "missing_facts", "slug_conflict", "high_risk_review", "integration_reconnect", "publishing_integration", "autopilot_paused", "budget_limit", "technical_issue", "human_review", "circuit_open"], maxSelect: 1, required: true },
    { name: "title", type: "text", max: 300, required: true },
    { name: "body", type: "text", max: 2000 },
    { name: "link", type: "text", max: 500 },
    { name: "evidence", type: "json" },
    { name: "status", type: "select", values: ["open", "done", "dismissed"], maxSelect: 1, required: true },
    { name: "dedup_key", type: "text", max: 300, required: true },
    { name: "remind_at", type: "date", required: false },
    { name: "reminders_sent", type: "number", min: 0, onlyInt: true },
    { name: "resolved_by", type: "relation", maxSelect: 1, collectionId: USERS_COLL, required: false, cascadeDelete: false },
    { name: "resolved_at", type: "date", required: false },
    ...timestamps(),
    ...autodates(),
  ], ADMIN_READ_RULES, {
    bareName: "autopilot_tasks",
    indexes: ["CREATE UNIQUE INDEX idx_autopilot_tasks_dedup ON autopilot_tasks (website, dedup_key)", "CREATE INDEX idx_autopilot_tasks_status ON autopilot_tasks (organization, status)"],
  });

  // Simple mode: safe auto-publish action (idempotent for existing installs).
  await ensureSelectValues("autopilot_actions", "action_type", AP_ACTIONS);

  // Circuit breaker per website + action type.
  await ensureCollection("autopilot_circuits", [
    ...tenantFields(),
    { name: "action_type", type: "select", values: AP_ACTIONS, maxSelect: 1, required: true },
    { name: "state", type: "select", values: ["closed", "open"], maxSelect: 1, required: true },
    { name: "consecutive_failures", type: "number", min: 0, onlyInt: true },
    { name: "last_error_class", type: "text", max: 40 },
    { name: "last_error_code", type: "text", max: 80 },
    { name: "opened_at", type: "date", required: false },
    { name: "closed_at", type: "date", required: false },
    ...timestamps(),
    ...autodates(),
  ], ADMIN_READ_RULES, { bareName: "autopilot_circuits", indexes: ["CREATE UNIQUE INDEX idx_autopilot_circuits_key ON autopilot_circuits (website, action_type)"] });
  await ensureSelectValues("autopilot_circuits", "action_type", AP_ACTIONS);

  // Feedback history: action -> publication version -> observation windows.
  // Observations are REAL Search Console aggregates only (or no_data); they
  // record what happened after a change, never a causal claim.
  await ensureCollection("autopilot_outcomes", [
    ...tenantFields(),
    { name: "action", type: "relation", maxSelect: 1, collectionId: rel("autopilot_actions"), required: true, cascadeDelete: false },
    { name: "article", type: "relation", maxSelect: 1, collectionId: rel("articles"), required: false, cascadeDelete: false },
    { name: "publication", type: "relation", maxSelect: 1, collectionId: rel("article_publications"), required: false, cascadeDelete: false },
    { name: "article_version", type: "number", min: 0, onlyInt: true },
    { name: "public_url", type: "text", max: 1000 },
    { name: "change_type", type: "select", values: ["publish", "update"], maxSelect: 1, required: true },
    { name: "changed_at", type: "date", required: true },
    { name: "observations", type: "json" },
    { name: "status", type: "select", values: ["waiting_for_data", "observing", "observed"], maxSelect: 1, required: true },
    ...timestamps(),
    ...autodates(),
  ], ADMIN_READ_RULES, { bareName: "autopilot_outcomes", indexes: ["CREATE UNIQUE INDEX idx_autopilot_outcomes_action ON autopilot_outcomes (action)"] });

  // Worker liveness (service health board). Written by workers (superuser).
  await ensureCollection("service_heartbeats", [
    { name: "service", type: "text", max: 60, required: true },
    { name: "version", type: "text", max: 60 },
    { name: "instance", type: "text", max: 100 },
    { name: "last_seen_at", type: "date", required: true },
    { name: "details", type: "json" },
    ...autodates(),
  ], { listRule: '@request.auth.id != ""', viewRule: '@request.auth.id != ""', createRule: null, updateRule: null, deleteRule: null }, {
    bareName: "service_heartbeats",
    indexes: ["CREATE UNIQUE INDEX idx_service_heartbeats_service ON service_heartbeats (service)"],
  });

  // Safe default Autopilot policy (OFF, disabled) for every existing website.
  // Idempotent: websites that already have a policy are untouched, so this
  // NEVER changes an admin's choice and never enables anything.
  {
    const D = {
      enabled: false, mode: "OFF", paused: false, schedule: "weekly",
      allowed_actions: ["CRAWL", "STRATEGY_REFRESH", "GENERATE_CONTENT", "RECHECK_CONTENT", "REQUEST_REVISION", "PUBLISH", "VERIFY_PUBLICATION", "UPDATE_PUBLICATION", "NOTIFY_HUMAN", "WAIT"],
      allowed_environments: ["staging"], max_actions_per_day: 10, max_content_jobs_per_day: 1, max_content_jobs_per_week: 3, max_publications_per_week: 3,
      max_revision_jobs_per_article: 1, max_strategy_refresh_per_week: 1, max_crawls_per_week: 1, max_ai_budget_daily: 5, max_ai_budget_monthly: 50,
      max_ai_calls_daily: 60, max_ai_tokens_daily: 2000000, require_human_publish_approval: true, publish_after_human_approval: false,
      pause_on_high_risk: true, pause_on_fact_failure: true, pause_on_integration_error: true, cooldown_hours: 24, optimization_cooldown_days: 28,
      crawl_max_age_days: 14, strategy_max_age_days: 30, approval_reminder_days: 3, timezone: "America/Ciudad_Juarez", version: 1,
    };
    let page = 1, created = 0;
    for (;;) {
      const r = await request(`/api/collections/websites/records?perPage=200&page=${page}&fields=id,organization,client`);
      if (!r.ok) throw new Error(`list websites failed (${r.status})`);
      const j = await r.json();
      for (const w of j.items) {
        const q = await request(`/api/collections/autopilot_policies/records?perPage=1&filter=${encodeURIComponent(`website = "${w.id}"`)}`);
        if ((await q.json()).items.length) continue;
        const ts = new Date().toISOString();
        const c = await request("/api/collections/autopilot_policies/records", { method: "POST", body: JSON.stringify({ ...D, organization: w.organization, client: w.client, website: w.id, created_at: ts, updated_at: ts }) });
        if (!c.ok && c.status !== 400) throw new Error(`default policy failed (${c.status}): ${await c.text()}`);
        if (c.ok) created++;
      }
      if (page >= j.totalPages) break;
      page++;
    }
    console.log(`✓ autopilot default policies (OFF) created: ${created}`);
  }

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
  usersCol.createRule = '@request.auth.organization.id != "" && @request.auth.role = "admin" && @request.body.organization = @request.auth.organization.id';
  // Self-service profile edits only: organization/role/status changes are
  // blocked here and re-checked by the users guard in pb_hooks (defense in depth).
  usersCol.updateRule = '(@request.auth.id = id && @request.body.organization:isset = false && @request.body.role:isset = false && @request.body.status:isset = false) || (@request.auth.organization.id = organization.id && @request.auth.role = "admin" && @request.auth.id != id && @request.body.organization:isset = false)';
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
  for (const name of ["articles", "article_versions", "content_jobs", "research_sources", "article_research", "article_claims", "article_internal_links", "article_qa_reports", "integrations", "article_publications", "publish_jobs", "publication_events", "published_content", "content_taxonomies", "gsc_connections", "gsc_properties", "gsc_oauth_states", "gsc_sync_jobs", "gsc_site_daily", "gsc_page_daily", "gsc_query_daily", "gsc_query_page_daily", "gsc_query_labels", "analytics_opportunities", "gsc_data_quality_flags", "notifications", "autopilot_policies", "autopilot_controls", "autopilot_runs", "autopilot_signals", "autopilot_decisions", "autopilot_actions", "autopilot_triggers", "autopilot_run_events", "autopilot_tasks", "autopilot_circuits", "autopilot_outcomes", "service_heartbeats"]) console.log(`   ${name}: ${REF[name]}`);
  console.log(`   PB_URL: ${PB_URL}`);
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });