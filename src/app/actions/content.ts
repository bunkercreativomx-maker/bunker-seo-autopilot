"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/pocketbase/auth";
import { adminAuth, createBaseClient } from "@/lib/pocketbase/client";
import * as core from "@/lib/content/core";
import type { User } from "@/lib/types";

export type ContentActionState = { error?: string; success?: string; jobId?: string; articleId?: string } | undefined;

// Server actions resolve the SESSION user, then perform writes through the
// superuser client. core.* re-checks org/client/website ownership of every
// record, so the admin client can never be used across tenants.
async function context() {
  const { user } = await requireUser();
  const actor: core.ContentActor = { id: user.id, organization: user.organization ?? "", role: user.role, name: (user as User).name, email: user.email };
  const admin = createBaseClient();
  admin.autoCancellation(false);
  await adminAuth(admin);
  return { admin, actor };
}

function message(error: unknown): string {
  if (error instanceof core.ContentError) return error.message;
  console.error("[content] action failed", error);
  return "The operation failed. Please try again.";
}

function refresh(articleId: string, websiteId?: string) {
  revalidatePath(`/articles/${articleId}`);
  revalidatePath("/content");
  if (websiteId) {
    revalidatePath(`/websites/${websiteId}/content`);
    revalidatePath(`/websites/${websiteId}/strategy`);
  }
}

export async function startGenerationAction(_prev: ContentActionState, formData: FormData): Promise<ContentActionState> {
  const websiteId = String(formData.get("websiteId") ?? "");
  const kind = String(formData.get("sourceKind") ?? "");
  const sourceId = String(formData.get("sourceId") ?? "");
  if (!websiteId || !sourceId || (kind !== "opportunity" && kind !== "plan_item")) return { error: "Missing generation source." };
  let articleId = "";
  try {
    const { admin, actor } = await context();
    const result = await core.startGeneration(admin, actor, websiteId, { kind, id: sourceId }, {
      content_type: formData.get("content_type"),
      primary_keyword: formData.get("primary_keyword"),
      target_location: formData.get("target_location"),
      recommended_url: formData.get("recommended_url"),
      reason: formData.get("reason"),
      language: formData.get("language"),
      pause_after_brief: formData.get("pause_after_brief"),
    });
    articleId = result.article.id;
    refresh(articleId, websiteId);
  } catch (error) {
    return { error: message(error) };
  }
  redirect(`/articles/${articleId}`);
}

async function simple(formData: FormData, run: (admin: Awaited<ReturnType<typeof context>>["admin"], actor: core.ContentActor, articleId: string) => Promise<unknown>, success: string): Promise<ContentActionState> {
  const articleId = String(formData.get("articleId") ?? "");
  const websiteId = String(formData.get("websiteId") ?? "");
  if (!articleId) return { error: "Missing article." };
  try {
    const { admin, actor } = await context();
    const result = await run(admin, actor, articleId);
    refresh(articleId, websiteId);
    const jobId = result && typeof result === "object" && "id" in result && "mode" in result ? String((result as { id: string }).id) : undefined;
    return { success, jobId };
  } catch (error) {
    return { error: message(error) };
  }
}

export async function saveArticleAction(_prev: ContentActionState, formData: FormData): Promise<ContentActionState> {
  return simple(formData, async (admin, actor, id) => {
    const res = await core.saveManualEdit(admin, actor, id, {
      title: formData.get("title"), slug: formData.get("slug"), seo_title: formData.get("seo_title"),
      meta_description: formData.get("meta_description"), excerpt: formData.get("excerpt"), content: formData.get("content"),
    }, String(formData.get("change_reason") ?? ""));
    if (!res.changed) throw new core.ContentError("NO_CHANGES", "No changes to save.");
    return res;
  }, "Saved as a new version. QA must re-run before approval.");
}

export async function restoreVersionAction(_prev: ContentActionState, formData: FormData): Promise<ContentActionState> {
  const version = Number(formData.get("version"));
  return simple(formData, (admin, actor, id) => core.restoreVersion(admin, actor, id, version), `Version ${version} restored as a new version.`);
}

export async function approveArticleAction(_prev: ContentActionState, formData: FormData): Promise<ContentActionState> {
  return simple(formData, (admin, actor, id) => core.approveArticle(admin, actor, id, {
    acknowledgeHighRisk: formData.get("ack_high_risk") === "on",
    acknowledgeWarnings: formData.get("ack_warnings") === "on",
  }), "Approved. Ready for Phase 5 — nothing was published.");
}

export async function rejectArticleAction(_prev: ContentActionState, formData: FormData): Promise<ContentActionState> {
  return simple(formData, (admin, actor, id) => core.rejectArticle(admin, actor, id, String(formData.get("reason") ?? "")), "Rejected. The content remains stored.");
}

export async function requestRevisionAction(_prev: ContentActionState, formData: FormData): Promise<ContentActionState> {
  return simple(formData, (admin, actor, id) => core.requestRevision(admin, actor, id, String(formData.get("instruction") ?? "")), "Revision queued.");
}

export async function retryGenerationAction(_prev: ContentActionState, formData: FormData): Promise<ContentActionState> {
  return simple(formData, (admin, actor, id) => core.retryGeneration(admin, actor, id), "Retry queued. Completed stages are reused.");
}

export async function recheckArticleAction(_prev: ContentActionState, formData: FormData): Promise<ContentActionState> {
  return simple(formData, (admin, actor, id) => core.requestRecheck(admin, actor, id), "Fact check + QA queued for the current version.");
}

export async function continueAfterBriefAction(_prev: ContentActionState, formData: FormData): Promise<ContentActionState> {
  return simple(formData, (admin, actor, id) => core.continueAfterBrief(admin, actor, id), "Drafting queued.");
}

export async function saveBriefAction(_prev: ContentActionState, formData: FormData): Promise<ContentActionState> {
  return simple(formData, (admin, actor, id) => core.saveBrief(admin, actor, id, String(formData.get("brief") ?? "")), "Brief saved. The outline will be regenerated from it.");
}
