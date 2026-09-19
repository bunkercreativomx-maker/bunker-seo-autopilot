"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createBaseClient } from "@/lib/pocketbase/client";
import { AUTH_COOKIE } from "@/lib/pocketbase/auth";
import { logActivity } from "@/lib/pocketbase/activity";

export type LoginState = { error?: string } | undefined;

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  const pb = createBaseClient();
  try {
    await pb.collection("users").authWithPassword(email, password);
  } catch {
    return { error: "Invalid credentials." };
  }

  const model = pb.authStore.model as { id?: string; organization?: string } | null;
    const userId = model?.id ?? "";
    const orgId = model?.organization ?? "";

    // Persist PocketBase's own authStore (token + model) in an httpOnly cookie.
    // loadFromCookie expects the JSON-serialized authStore, not the bare token.
    const cookieValue = encodeURIComponent(
      JSON.stringify({ token: pb.authStore.token, model: pb.authStore.model })
    );
    const cookieStore = await cookies();
    cookieStore.set(AUTH_COOKIE, cookieValue, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7, // 7 days
    });

  // Log the login (best-effort; never blocks the redirect).
  if (orgId) {
    await logActivity({
      organization: orgId,
      user: userId,
      action: "USER_LOGIN",
      entity_type: "user",
      entity_id: userId,
    });
  }

  redirect("/dashboard");
}

export async function logout(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(AUTH_COOKIE);
  redirect("/login");
}
