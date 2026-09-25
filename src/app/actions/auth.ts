"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createBaseClient } from "@/lib/pocketbase/client";
import { AUTH_COOKIE, getSessionClient, serializeSession, sessionCookieOptions } from "@/lib/pocketbase/auth";
import { userOperation } from "@/lib/pocketbase/operations";

export type LoginState = { error?: string } | undefined;

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  // USER_LOGIN is logged inside PocketBase (pb_hooks/bsa_activity.pb.js).
  const pb = createBaseClient();
  try {
    await pb.collection("users").authWithPassword(email, password);
  } catch {
    return { error: "Invalid credentials." };
  }
  const status = (pb.authStore.record as { status?: string } | null)?.status;
  if (status && status !== "active") return { error: "This account is disabled." };

  // Always replace any existing cookie with the freshly minted token
  // (prevents session fixation). Only the token is stored.
  const cookieStore = await cookies();
  cookieStore.delete(AUTH_COOKIE);
  cookieStore.set(AUTH_COOKIE, serializeSession(pb.authStore.token), sessionCookieOptions());

  redirect("/today");
}

export async function logout(): Promise<void> {
  // Revoke every token of this user server-side, then drop the cookie.
  const pb = await getSessionClient();
  if (pb) {
    await userOperation(pb, "logout", {}).catch((error) => console.warn("[auth] server-side logout failed", error));
  }
  const cookieStore = await cookies();
  cookieStore.delete(AUTH_COOKIE);
  redirect("/login");
}
