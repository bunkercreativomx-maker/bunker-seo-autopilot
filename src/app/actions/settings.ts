"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/pocketbase/auth";
import { createBaseClient } from "@/lib/pocketbase/client";

export type SettingsState = { error?: string; success?: string } | undefined;

export async function updateProfileAction(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const { pb, user } = await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Name is required." };

  try {
    await pb.collection("users").update(user.id, { name });
  } catch (e) {
    console.error("[settings] profile update failed", e);
    return { error: "Could not update your profile." };
  }
  revalidatePath("/settings");
  return { success: "Profile updated." };
}

export async function updateOrganizationAction(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const { user } = await requireUser();
  if (!user.organization) return { error: "Your account is not linked to an organization." };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Organization name is required." };

  try {
    // organizations.updateRule is null (superuser only), so use the admin client.
    const pb = createBaseClient();
    const email = process.env.PB_ADMIN_EMAIL;
    const password = process.env.PB_ADMIN_PASSWORD;
    if (!email || !password) return { error: "Server admin credentials not configured." };
    await pb.collection("_superusers").authWithPassword(email, password);
    await pb.collection("organizations").update(user.organization, { name });
  } catch (e) {
    console.error("[settings] org update failed", e);
    return { error: "Could not update the organization." };
  }
  revalidatePath("/settings");
  return { success: "Organization updated." };
}
