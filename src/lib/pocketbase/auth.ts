import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import PocketBase from "pocketbase";
import { createBaseClient } from "./client";
import type { User } from "@/lib/types";

export const AUTH_COOKIE = "pb_auth";

/**
 * Session cookie: httpOnly, Secure in production, SameSite=Lax, 5 days
 * (matches the PocketBase users token duration). It stores ONLY the
 * PocketBase user token — no password, no superuser credential and no user
 * profile (role/organization are always re-read from PocketBase, never trusted
 * from the cookie). A new token is minted on every login, so a pre-set cookie
 * cannot fixate a session; logout revokes all tokens server-side.
 */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 5;

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE,
  };
}

export function serializeSession(token: string): string {
  return encodeURIComponent(JSON.stringify({ token }));
}

function tokenFromCookie(value: string): string {
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as { token?: unknown };
    return typeof parsed?.token === "string" ? parsed.token : "";
  } catch {
    return "";
  }
}

/**
 * Build a PocketBase client authenticated as the current session user.
 * The token is verified by PocketBase (authRefresh), which also returns the
 * CURRENT user record — role, organization and status come from the
 * database, so a disabled or re-scoped account takes effect immediately.
 * Returns null when there is no valid session.
 */
export async function getSessionClient(): Promise<PocketBase | null> {
  const cookieStore = await cookies();
  const token = tokenFromCookie(cookieStore.get(AUTH_COOKIE)?.value ?? "");
  if (!token) return null;
  const pb = createBaseClient();
  pb.autoCancellation(false);
  pb.authStore.save(token, null);
  if (!pb.authStore.isValid) return null;
  try {
    await pb.collection("users").authRefresh({ requestKey: null });
  } catch {
    return null; // expired, revoked (logout) or invalid token
  }
  const user = pb.authStore.record as unknown as User | null;
  if (!user || (user.status && user.status !== "active")) return null;
  return pb;
}

/** Memoized current user (null when unauthenticated). */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const pb = await getSessionClient();
  if (!pb) return null;
  return (pb.authStore.record as unknown as User | null) ?? null;
});

/** Require an authenticated session; redirect to /login otherwise. */
export async function requireUser(): Promise<{ pb: PocketBase; user: User }> {
  const pb = await getSessionClient();
  if (!pb) {
    redirect("/login");
  }
  const user = pb.authStore.record as unknown as User;
  if (!user) redirect("/login");
  return { pb, user };
}

/**
 * UI gate for Phase 1–4 workspace edits; PocketBase rules enforce the same
 * policy server-side. "viewer" (internal read-only) and "client" (the
 * agency's customer, review-only) cannot modify workspace data.
 */
export function canWrite(role: User["role"]): boolean {
  return role !== "viewer" && role !== "client";
}

export function isAdmin(role: User["role"]): boolean {
  return role === "admin" || role === "super_admin";
}
