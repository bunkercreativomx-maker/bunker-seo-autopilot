import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import PocketBase from "pocketbase";
import { createBaseClient } from "./client";
import type { User } from "@/lib/types";

export const AUTH_COOKIE = "pb_auth";

/**
 * Build a PocketBase client authenticated as the current session user.
 * Loads the auth token from the `pb_auth` cookie (PocketBase's own token).
 * Returns null when there is no valid session.
 */
export async function getSessionClient(): Promise<PocketBase | null> {
  const pb = createBaseClient();
  const cookieStore = await cookies();
  const value = cookieStore.get(AUTH_COOKIE)?.value ?? "";
  if (!value) return null;
  // loadFromCookie expects the full `pb_auth=<value>` string (see skill reference).
  pb.authStore.loadFromCookie(`${AUTH_COOKIE}=${value}`, AUTH_COOKIE);
  if (!pb.authStore.isValid) return null;
  try {
    await pb.collection("users").authRefresh();
  } catch {
    // expired / invalid token
    return null;
  }
  return pb;
}

/** Memoized current user (null when unauthenticated). */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const pb = await getSessionClient();
  if (!pb) return null;
  const model = pb.authStore.model as unknown as User | null;
  return model ?? null;
});

/** Require an authenticated session; redirect to /login otherwise. */
export async function requireUser(): Promise<{ pb: PocketBase; user: User }> {
  const pb = await getSessionClient();
  if (!pb) {
    redirect("/login");
  }
  const user = pb.authStore.model as unknown as User;
  if (!user) redirect("/login");
  return { pb, user };
}

/** Require a role at or above the given level (admin can do what editor/viewer can). */
export function canWrite(role: User["role"]): boolean {
  return role !== "viewer";
}

export function isAdmin(role: User["role"]): boolean {
  return role === "admin" || role === "super_admin";
}
