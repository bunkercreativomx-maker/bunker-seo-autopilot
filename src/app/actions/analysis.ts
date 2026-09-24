"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser, canWrite } from "@/lib/pocketbase/auth";
import { getWebsite } from "@/lib/pocketbase/websites";
import { createCrawlJob } from "@/lib/pocketbase/analysis";

/**
 * Trigger a website analysis (or re-analysis) by creating a queued crawl job.
 * The standalone crawler worker polls PocketBase and processes it. Returns
 * nothing — redirects back so the overview shows crawling progress.
 */
export async function analyzeWebsiteAction(formData: FormData): Promise<void> {
  const { pb, user } = await requireUser();
  if (!canWrite(user.role)) return;

  const websiteId = String(formData.get("websiteId") ?? "");
  if (!websiteId) return;

  const organization = user.organization ?? "";
  if (!organization) return;

  try {
    const website = await getWebsite(pb, websiteId);
    if (!website) return;

    await createCrawlJob(pb, organization, website.id, website.client, user.id);
  } catch (e) {
    console.error("[analysis] trigger failed", e);
  }

  revalidatePath(`/websites/${websiteId}`);
  revalidatePath(`/websites/${websiteId}/seo`);
  revalidatePath(`/websites/${websiteId}/pages`);
  redirect(`/websites/${websiteId}`);
}