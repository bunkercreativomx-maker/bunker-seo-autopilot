#!/usr/bin/env node
/**
 * Seed test data for the Phase 1 test suite.
 * Creates two organizations (A and B), an admin user per org, a client per org,
 * and two websites under client A. Idempotent-ish: uses fixed emails and cleans
 * up before re-creating.
 *
 * Usage: node scripts/seed-test.mjs
 */
import PocketBase from "pocketbase";
import { assertLocalTarget } from "./lib/local-only.mjs";

const PB_URL = process.env.PB_URL || "http://127.0.0.1:8095";
assertLocalTarget(PB_URL, "seed-test");
const ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL || "admin@seo.autopilot";
const ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD || "SeoAutopilot!2026x";

const EMAIL_A = "admin-a@test.local";
const EMAIL_B = "admin-b@test.local";

async function main() {
  const pb = new PocketBase(PB_URL);
  await pb.collection("_superusers").authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);

  // Clean up previous test data (children first).
  for (const col of ["activity_logs", "websites", "clients"]) {
    const list = await pb.collection(col).getFullList(200);
    for (const r of list) {
      try { await pb.collection(col).delete(r.id); } catch {}
    }
  }
  for (const email of [EMAIL_A, EMAIL_B]) {
    try {
      const u = await pb.collection("users").getFirstListItem(`email = "${email}"`);
      await pb.collection("users").delete(u.id);
    } catch {}
  }
  for (const col of ["organizations"]) {
    const list = await pb.collection(col).getFullList(200);
    for (const r of list) {
      try { await pb.collection(col).delete(r.id); } catch {}
    }
  }

  // Org A + admin A
  const orgA = await pb.collection("organizations").create({
    name: "Organization A",
    slug: "org-a",
    status: "active",
    created_at: new Date().toISOString(),
  });
  const userA = await pb.collection("users").create({
    email: EMAIL_A,
    password: "TestPass!2026",
    passwordConfirm: "TestPass!2026",
    name: "Admin A",
    organization: orgA.id,
    role: "admin",
    status: "active",
  });

  // Org B + admin B
  const orgB = await pb.collection("organizations").create({
    name: "Organization B",
    slug: "org-b",
    status: "active",
    created_at: new Date().toISOString(),
  });
  const userB = await pb.collection("users").create({
    email: EMAIL_B,
    password: "TestPass!2026",
    passwordConfirm: "TestPass!2026",
    name: "Admin B",
    organization: orgB.id,
    role: "admin",
    status: "active",
  });

  // Client A (org A)
  const clientA = await pb.collection("clients").create({
    organization: orgA.id,
    business_name: "Client A",
    slug: "client-a",
    status: "active",
    created_at: new Date().toISOString(),
  });
  // Client B (org B)
  const clientB = await pb.collection("clients").create({
    organization: orgB.id,
    business_name: "Client B",
    slug: "client-b",
    status: "active",
    created_at: new Date().toISOString(),
  });

  // Two websites under client A
  const w1 = await pb.collection("websites").create({
    organization: orgA.id,
    client: clientA.id,
    name: "Website One",
    domain: "website-one.com",
    platform: "nextjs",
    status: "active",
    created_at: new Date().toISOString(),
  });
  const w2 = await pb.collection("websites").create({
    organization: orgA.id,
    client: clientA.id,
    name: "Website Two",
    domain: "website-two.com",
    platform: "wordpress",
    status: "active",
    created_at: new Date().toISOString(),
  });

  console.log(JSON.stringify({
    orgA: orgA.id, userA: userA.id,
    orgB: orgB.id, userB: userB.id,
    clientA: clientA.id, clientB: clientB.id,
    websiteOne: w1.id, websiteTwo: w2.id,
  }, null, 2));
}

main().catch((e) => { console.error("❌", e); process.exit(1); });