#!/usr/bin/env node
/**
 * Phase 3 strategy smoke fixture (replaces the former /opt/data/prod-phase3-smoke.mjs).
 *
 * SAFETY — why this file exists in this shape:
 *   The old script authenticated as superuser against production and PATCHed a
 *   real client with ASSUMED business context (description, USP, brand voice,
 *   "no upfront investment"...). That re-injected invented facts into prod.
 *
 *   This fixture:
 *     - refuses any non-loopback target and the production port (assertLocalTarget)
 *     - creates its OWN tagged organization/client/website; never searches for or
 *       modifies an existing client
 *     - seeds only neutral fixture text clearly marked as fixture data
 *     - deletes exactly the records it created
 *
 * Usage (ephemeral local PB only):
 *   PB_URL=http://127.0.0.1:8097 PB_ADMIN_EMAIL=... PB_ADMIN_PASSWORD=... node scripts/fixtures/phase3-smoke.mjs
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import PocketBase from "pocketbase";
import { assertLocalTarget } from "../lib/local-only.mjs";

const PB_URL = process.env.PB_URL || "http://127.0.0.1:8097";
assertLocalTarget(PB_URL, "phase3-smoke");
const tag = `smoke-${randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();
const pb = new PocketBase(PB_URL);
const created = [];
const make = async (collection, data) => { const r = await pb.collection(collection).create(data); created.push([collection, r.id]); return r; };

try {
  await pb.collection("_superusers").authWithPassword(process.env.PB_ADMIN_EMAIL, process.env.PB_ADMIN_PASSWORD);
  const org = await make("organizations", { name: `${tag} Fixture Org`, slug: `${tag}-org`, status: "active", created_at: now() });
  const client = await make("clients", { organization: org.id, business_name: `${tag} Fixture Client`, slug: `${tag}-client`, services: "Fixture service", primary_language: "en", status: "active", created_at: now() });
  const website = await make("websites", { organization: org.id, client: client.id, name: `${tag} site`, domain: `${tag}.example.test`, platform: "custom", status: "active", created_at: now() });
  const fetched = await pb.collection("clients").getOne(client.id);
  assert.equal(fetched.unique_selling_proposition || "", "", "fixture must not seed invented business claims");
  console.log(JSON.stringify({ ok: true, tag, website: website.id }));
} finally {
  for (const [collection, id] of created.reverse()) await pb.collection(collection).delete(id).catch(() => {});
}
