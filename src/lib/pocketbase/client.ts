import "server-only";
import PocketBase from "pocketbase";

/**
 * Base PocketBase client factory.
 * The public URL is fixed infrastructure (not a secret) — see the deploy skill:
 * a code-level default keeps a zero-env deployment rendering and signing in.
 *
 * There is intentionally NO superuser client in the web app. Requests are made
 * anonymously (login) or with the signed-in user's own token (getSessionClient
 * in ./auth.ts). Privileged workflows run inside PocketBase (pb_hooks/) after
 * validating that user; workers keep their own server-side credentials.
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
