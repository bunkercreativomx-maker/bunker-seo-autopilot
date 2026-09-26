"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser, canWrite } from "@/lib/pocketbase/auth";
import { createWebsite, updateWebsite, archiveWebsite } from "@/lib/pocketbase/websites";
import { websiteSchema } from "@/lib/validation";
import { isValidDomain, normalizeDomain, normalizeUrl, slugify } from "@/lib/types";
import { createClient } from "@/lib/pocketbase/clients";
import { saveSimpleSettings } from "@/lib/pocketbase/today";
import { isAdmin } from "@/lib/pocketbase/auth";

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
    await createWebsite(pb, organization, {
      ...parsed.data,
      domain: normalizeDomain(parsed.data.domain),
      sitemap_url: normalizeUrl(parsed.data.sitemap_url ?? ""),
      robots_url: normalizeUrl(parsed.data.robots_url ?? ""),
      blog_url: normalizeUrl(parsed.data.blog_url ?? ""),
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
    await updateWebsite(pb, id, {
      ...parsed.data,
      domain: normalizeDomain(parsed.data.domain),
      sitemap_url: normalizeUrl(parsed.data.sitemap_url ?? ""),
      robots_url: normalizeUrl(parsed.data.robots_url ?? ""),
      blog_url: normalizeUrl(parsed.data.blog_url ?? ""),
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
    await archiveWebsite(pb, id);
  } catch (e) {
    console.error("[website] archive failed", e);
  }

  revalidatePath("/websites");
  revalidatePath("/dashboard");
  redirect("/websites");
}

export type QuickAddState = { error?: string } | undefined;

/**
 * One-step "Add website": only the URL (+ optional package). Creates the
 * client and website, then queues a crawl flagged auto_setup. The crawler reads
 * the site, learns the business (name, services, locations, phone, email,
 * facts quoted from the site) and its language, and queues the topic plan.
 * Blogs are written in the language detected on the site.
 */
export async function quickAddWebsiteAction(_prev: QuickAddState, formData: FormData): Promise<QuickAddState> {
  const { pb, user } = await requireUser();
  if (!canWrite(user.role)) return { error: "You do not have permission to add websites." };
  const organization = user.organization ?? "";
  if (!organization) return { error: "Your account is not linked to an organization." };

  const domain = normalizeDomain(String(formData.get("url") ?? ""));
  if (!domain || !isValidDomain(domain)) return { error: "Enter a valid website, e.g. tlalocsolfuturo.com" };
  const posts = Number(formData.get("posts") ?? 0);
  const existingClient = String(formData.get("client") ?? "");

  const dup = await pb.collection("websites").getList(1, 1, { filter: pb.filter("domain = {:d} && status != 'archived'", { d: domain }), requestKey: null }).catch(() => null);
  if (dup?.items[0]) redirect(`/websites/${dup.items[0].id}`);

  let websiteId = "";
  try {
    const clientId = existingClient || (await createClient(pb, organization, {
      business_name: domain, slug: slugify(domain), status: "active",
    } as Parameters<typeof createClient>[2])).id;
    const website = await createWebsite(pb, organization, {
      client: clientId, name: domain, domain, platform: "other", status: "active",
      primary_language: "", country: "", target_locations: "", sitemap_url: "", robots_url: "", blog_url: "",
    });
    websiteId = website.id;
    await pb.collection("crawl_jobs").create({
      organization, client: clientId, website: website.id, status: "queued",
      triggered_by: user.id, configuration: { auto_setup: true }, created_at: new Date().toISOString(),
    });
    if ([7, 15, 30].includes(posts) && isAdmin(user.role)) {
      await saveSimpleSettings(pb, website.id, true, false, posts).catch((e) => console.error("[website] package failed", e));
    }
  } catch (e) {
    console.error("[website] quick add failed", e);
    return { error: "Could not add the website. Please try again." };
  }

  revalidatePath("/websites");
  revalidatePath("/today");
  redirect(`/websites/${websiteId}`);
}

/** Re-learn the business from the site (fills only empty fields, adds new quoted facts). */
export async function relearnWebsiteAction(formData: FormData): Promise<void> {
  const { pb, user } = await requireUser();
  if (!canWrite(user.role)) return;
  const websiteId = String(formData.get("websiteId") ?? "");
  const website = websiteId ? await getWebsiteSafe(pb, websiteId) : null;
  if (!website || !user.organization) return;
  await pb.collection("crawl_jobs").create({
    organization: user.organization, client: website.client, website: website.id, status: "queued",
    triggered_by: user.id, configuration: { auto_setup: true }, created_at: new Date().toISOString(),
  }).catch((e) => console.error("[website] relearn failed", e));
  revalidatePath(`/websites/${websiteId}`);
  redirect(`/websites/${websiteId}`);
}

async function getWebsiteSafe(pb: Awaited<ReturnType<typeof requireUser>>["pb"], id: string) {
  try { return await pb.collection("websites").getOne<{ id: string; client: string }>(id, { requestKey: null }); } catch { return null; }
}
