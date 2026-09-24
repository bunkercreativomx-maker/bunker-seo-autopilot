"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/pocketbase/auth";
import { OperationError, userOperation } from "@/lib/pocketbase/operations";

export type SettingsState = { error?: string; success?: string } | undefined;

export async function updateProfileAction(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const { pb, user } = await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Name is required." };

  try {
    // Only the name is sent; role/organization/status changes are rejected by
    // the users update guard in pb_hooks/bsa_activity.pb.js.
    await pb.collection("users").update(user.id, { name });
  } catch (e) {
    console.error("[settings] profile update failed", e);
    return { error: "Could not update your profile." };
  }
  revalidatePath("/settings");
  return { success: "Profile updated." };
}

export async function updateOrganizationAction(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const { pb, user } = await requireUser();
  if (!user.organization) return { error: "Your account is not linked to an organization." };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Organization name is required." };

  try {
    // PocketBase validates that the caller is an admin of THIS organization.
    await userOperation(pb, "organization", { name });
  } catch (e) {
    if (e instanceof OperationError && e.status < 500) return { error: e.message };
    console.error("[settings] org update failed", e);
    return { error: "Could not update the organization." };
  }
  revalidatePath("/settings");
  return { success: "Organization updated." };
}
