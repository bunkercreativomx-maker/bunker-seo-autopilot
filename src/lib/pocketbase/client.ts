import "server-only";
import PocketBase from "pocketbase";

/**
 * Base PocketBase client factory.
 * The public URL is fixed infrastructure (not a secret) — see the deploy skill:
 * a code-level default keeps a zero-env deployment rendering and signing in.
 */
export function getPBUrl(): string {
  return (
    process.env.POCKETBASE_URL ??
    process.env.NEXT_PUBLIC_POCKETBASE_URL ??
    "http://127.0.0.1:8095"
  );
}

export function createBaseClient(): PocketBase {
  return new PocketBase(getPBUrl());
}

/**
 * Server-side admin client (superuser). Used ONLY for operations that must
 * bypass per-user rules: writing activity logs (createRule null) and inviting
 * users. Never expose this to the client.
 */
export function createAdminClient(): PocketBase {
  const email = process.env.PB_ADMIN_EMAIL;
  const password = process.env.PB_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error("PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD not configured");
  }
  const pb = createBaseClient();
  return pb;
}

export async function adminAuth(pb: PocketBase): Promise<void> {
  const email = process.env.PB_ADMIN_EMAIL;
  const password = process.env.PB_ADMIN_PASSWORD;
  if (!email || !password) throw new Error("PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD not configured");
  if (!pb.authStore.isValid) {
    await pb.collection("_superusers").authWithPassword(email, password);
  }
}
