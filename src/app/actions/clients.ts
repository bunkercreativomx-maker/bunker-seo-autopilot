"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser, canWrite } from "@/lib/pocketbase/auth";
import { createClient, updateClient, archiveClient } from "@/lib/pocketbase/clients";
import { logActivity } from "@/lib/pocketbase/activity";
import { clientSchema, clientSlug } from "@/lib/validation";

export type ClientActionState = { error?: string; fieldErrors?: Record<string, string[]> } | undefined;

export async function createClientAction(_prev: ClientActionState, formData: FormData): Promise<ClientActionState> {
  const { pb, user } = await requireUser();
  if (!canWrite(user.role)) return { error: "You do not have permission to create clients." };

  const raw = {
    business_name: String(formData.get("business_name") ?? ""),
    industry: String(formData.get("industry") ?? ""),
    description: String(formData.get("description") ?? ""),
    primary_language: String(formData.get("primary_language") ?? ""),
    secondary_languages: String(formData.get("secondary_languages") ?? ""),
    country: String(formData.get("country") ?? ""),
    primary_location: String(formData.get("primary_location") ?? ""),
    service_areas: String(formData.get("service_areas") ?? ""),
    target_audience: String(formData.get("target_audience") ?? ""),
    brand_voice: String(formData.get("brand_voice") ?? ""),
    services: String(formData.get("services") ?? ""),
    products: String(formData.get("products") ?? ""),
    unique_selling_proposition: String(formData.get("unique_selling_proposition") ?? ""),
    primary_cta: String(formData.get("primary_cta") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    email: String(formData.get("email") ?? ""),
    status: String(formData.get("status") ?? "active") as "active" | "inactive" | "archived",
  };

  const parsed = clientSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const organization = user.organization ?? "";
  if (!organization) return { error: "Your account is not linked to an organization." };

  try {
    const client = await createClient(pb, organization, {
      ...parsed.data,
      slug: clientSlug(parsed.data.business_name),
    });
    await logActivity({
      organization,
      user: user.id,
      client: client.id,
      action: "CLIENT_CREATED",
      entity_type: "client",
      entity_id: client.id,
      metadata: { business_name: client.business_name },
    });
  } catch (e) {
    console.error("[client] create failed", e);
    return { error: "Could not create the client. Please try again." };
  }

  revalidatePath("/clients");
  revalidatePath("/dashboard");
  redirect("/clients");
}

export async function updateClientAction(_prev: ClientActionState, formData: FormData): Promise<ClientActionState> {
  const { pb, user } = await requireUser();
  if (!canWrite(user.role)) return { error: "You do not have permission to edit clients." };

  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "Missing client id." };

  const raw = {
    business_name: String(formData.get("business_name") ?? ""),
    industry: String(formData.get("industry") ?? ""),
    description: String(formData.get("description") ?? ""),
    primary_language: String(formData.get("primary_language") ?? ""),
    secondary_languages: String(formData.get("secondary_languages") ?? ""),
    country: String(formData.get("country") ?? ""),
    primary_location: String(formData.get("primary_location") ?? ""),
    service_areas: String(formData.get("service_areas") ?? ""),
    target_audience: String(formData.get("target_audience") ?? ""),
    brand_voice: String(formData.get("brand_voice") ?? ""),
    services: String(formData.get("services") ?? ""),
    products: String(formData.get("products") ?? ""),
    unique_selling_proposition: String(formData.get("unique_selling_proposition") ?? ""),
    primary_cta: String(formData.get("primary_cta") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    email: String(formData.get("email") ?? ""),
    status: String(formData.get("status") ?? "active") as "active" | "inactive" | "archived",
  };

  const parsed = clientSchema.safeParse(raw);
  if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors };

  try {
    const client = await updateClient(pb, id, parsed.data);
    await logActivity({
      organization: user.organization ?? "",
      user: user.id,
      client: client.id,
      action: "CLIENT_UPDATED",
      entity_type: "client",
      entity_id: client.id,
      metadata: { business_name: client.business_name },
    });
  } catch (e) {
    console.error("[client] update failed", e);
    return { error: "Could not update the client." };
  }

  revalidatePath("/clients");
  revalidatePath(`/clients/${id}`);
  revalidatePath("/dashboard");
  redirect(`/clients/${id}`);
}

export async function archiveClientAction(formData: FormData): Promise<void> {
  const { pb, user } = await requireUser();
  if (!canWrite(user.role)) return;

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  try {
    const client = await archiveClient(pb, id);
    await logActivity({
      organization: user.organization ?? "",
      user: user.id,
      client: client.id,
      action: "CLIENT_ARCHIVED",
      entity_type: "client",
      entity_id: client.id,
      metadata: { business_name: client.business_name },
    });
  } catch (e) {
    console.error("[client] archive failed", e);
  }

  revalidatePath("/clients");
  revalidatePath("/dashboard");
  redirect("/clients");
}
