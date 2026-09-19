#!/usr/bin/env node
/**
 * Bunker SEO Autopilot — Phase 1 PocketBase schema bootstrap.
 * Creates/updates the multi-tenant collections and access rules.
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

async function ensureCollection(name, fields, rules, { bareName } = {}) {
  try {
    const ex = await getCollection(name);
    const merged = { ...ex, ...rules };
    for (const f of fields) {
      if (!merged.fields.some((x) => x.name === f.name)) merged.fields.push(f);
    }
    await patchCollection(name, merged);
    REF[bareName || name] = ex.id;
    console.log(`ℹ️  ${name} exists (${ex.id}) — rules/fields ensured`);
    return ex.id;
  } catch {
    // not found -> create below
  }
  const body = { name, type: "base", fields, ...rules };
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
  console.log(`   organizations: ${REF.organizations}`);
  console.log(`   clients:       ${REF.clients}`);
  console.log(`   websites:      ${REF.websites}`);
  console.log(`   activity_logs: ${REF.activity_logs}`);
  console.log(`   PB_URL: ${PB_URL}`);
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });