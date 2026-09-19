"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser, canWrite } from "@/lib/pocketbase/auth";
import { createWebsite, updateWebsite, archiveWebsite } from "@/lib/pocketbase/websites";
import { logActivity } from "@/lib/pocketbase/activity";
import { websiteSchema } from "@/lib/validation";
import { normalizeDomain, normalizeUrl } from "@/lib/types";

export type WebsiteActionState = { error?: string; fieldErrors?: Record<string, string[]> } | undefined;

export async function createWebsiteAction(_prev: WebsiteActionState, formData: FormData): Promise<WebsiteActionState> {
  const { pb, user } = await requireUser();
  if (!canWrite(user.role)) return { error: "You do not have permission to create websites." };

  const raw = {
    client: String(formData.get("client") ?? ""),
    name: String(formData.get("name") ?? ""),
    domain: String(formData.get("domain") ?? ""),
    platform: String(formData.get("platform") ?? "other") as "nextjs" | "react" | "wordpress" | "custom" | "other",
    primary_language: String(formData.get("primary_language") ?? ""),
    country: String(formData.get("country") ?? ""),
    target_locations: String(formData.get("target_locations") ?? ""),
    sitemap_url: String(formData.get("sitemap_url") ?? ""),
    robots_url: String(formData.get("robots_url") ?? ""),
    blog_url: String(formData.get("blog_url") ?? ""),
    status: String(formData.get("status") ?? "active") as "active" | "inactive" | "archived",
  };

  const parsed = websiteSchema.safeParse(raw);
  if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors };

  const organization = user.organization ?? "";
  if (!organization) return { error: "Your account is not linked to an organization." };

  try {
    const website = await createWebsite(pb, organization, {
      ...parsed.data,
      domain: normalizeDomain(parsed.data.domain),
      sitemap_url: normalizeUrl(parsed.data.sitemap_url ?? ""),
      robots_url: normalizeUrl(parsed.data.robots_url ?? ""),
      blog_url: normalizeUrl(parsed.data.blog_url ?? ""),
    });
    await logActivity({
      organization,
      user: user.id,
      client: website.client,
      website: website.id,
      action: "WEBSITE_CREATED",
      entity_type: "website",
      entity_id: website.id,
      metadata: { name: website.name, domain: website.domain },
    });
  } catch (e) {
    console.error("[website] create failed", e);
    return { error: "Could not create the website. Please try again." };
  }

  revalidatePath("/websites");
  revalidatePath(`/clients/${raw.client}`);
  revalidatePath("/dashboard");
  redirect(`/clients/${raw.client}`);
}

export async function updateWebsiteAction(_prev: WebsiteActionState, formData: FormData): Promise<WebsiteActionState> {
  const { pb, user } = await requireUser();
  if (!canWrite(user.role)) return { error: "You do not have permission to edit websites." };

  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "Missing website id." };

  const raw = {
    client: String(formData.get("client") ?? ""),
    name: String(formData.get("name") ?? ""),
    domain: String(formData.get("domain") ?? ""),
    platform: String(formData.get("platform") ?? "other") as "nextjs" | "react" | "wordpress" | "custom" | "other",
    primary_language: String(formData.get("primary_language") ?? ""),
    country: String(formData.get("country") ?? ""),
    target_locations: String(formData.get("target_locations") ?? ""),
    sitemap_url: String(formData.get("sitemap_url") ?? ""),
    robots_url: String(formData.get("robots_url") ?? ""),
    blog_url: String(formData.get("blog_url") ?? ""),
    status: String(formData.get("status") ?? "active") as "active" | "inactive" | "archived",
  };

  const parsed = websiteSchema.safeParse(raw);
  if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors };

  try {
    const website = await updateWebsite(pb, id, {
      ...parsed.data,
      domain: normalizeDomain(parsed.data.domain),
      sitemap_url: normalizeUrl(parsed.data.sitemap_url ?? ""),
      robots_url: normalizeUrl(parsed.data.robots_url ?? ""),
      blog_url: normalizeUrl(parsed.data.blog_url ?? ""),
    });
    await logActivity({
      organization: user.organization ?? "",
      user: user.id,
      client: website.client,
      website: website.id,
      action: "WEBSITE_UPDATED",
      entity_type: "website",
      entity_id: website.id,
      metadata: { name: website.name, domain: website.domain },
    });
  } catch (e) {
    console.error("[website] update failed", e);
    return { error: "Could not update the website." };
  }

  revalidatePath("/websites");
  revalidatePath(`/websites/${id}`);
  revalidatePath(`/clients/${raw.client}`);
  revalidatePath("/dashboard");
  redirect(`/websites/${id}`);
}

export async function archiveWebsiteAction(formData: FormData): Promise<void> {
  const { pb, user } = await requireUser();
  if (!canWrite(user.role)) return;

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  try {
    const website = await archiveWebsite(pb, id);
    await logActivity({
      organization: user.organization ?? "",
      user: user.id,
      client: website.client,
      website: website.id,
      action: "WEBSITE_ARCHIVED",
      entity_type: "website",
      entity_id: website.id,
      metadata: { name: website.name, domain: website.domain },
    });
  } catch (e) {
    console.error("[website] archive failed", e);
  }

  revalidatePath("/websites");
  revalidatePath("/dashboard");
  redirect("/websites");
}
