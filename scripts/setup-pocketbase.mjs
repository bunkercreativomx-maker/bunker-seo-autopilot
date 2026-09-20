#!/usr/bin/env node
/**
 * Bunker SEO Autopilot — PocketBase schema bootstrap (Phase 1 + Phase 2).
 * Creates/updates the multi-tenant collections and access rules idempotently.
 *
 * Usage:
 *   node scripts/setup-pocketbase.mjs
 *   PB_URL=... PB_ADMIN_EMAIL=... PB_ADMIN_PASSWORD=... node scripts/setup-pocketbase.mjs
 *
 * Idempotent: safe to run repeatedly. Superuser must already exist.
 */
const PB_URL = process.env.PB_URL || "http://127.0.0.1:8095";
const PB_ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL || "admin@seo.autopilot";
const PB_ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD || "SeoAutopilot!2026x";
const USERS_COLL = "_pb_users_auth_";

const REF = {}; // name -> collection id

async function authSuperuser() {
  const r = await fetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: PB_ADMIN_EMAIL, password: PB_ADMIN_PASSWORD }),
  });
  if (!r.ok) throw new Error(`Superuser auth failed (${r.status}): ${await r.text()}`);
  return (await r.json()).token;
}

async function request(path, opts = {}, auth = true) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (auth) headers.Authorization = `Bearer ${await authSuperuser()}`;
  return fetch(`${PB_URL}${path}`, { ...opts, headers });
}

async function getCollection(name) {
  const r = await request(`/api/collections/${name}`);
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
  try {
    const ex = await getCollection(name);
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
  } catch {
    // not found -> create below
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
  console.log(`   PB_URL: ${PB_URL}`);
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });