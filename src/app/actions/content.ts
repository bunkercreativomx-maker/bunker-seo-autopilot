"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/pocketbase/auth";
import { OperationError, userOperation } from "@/lib/pocketbase/operations";

export type ContentActionState = { error?: string; success?: string; jobId?: string; articleId?: string } | undefined;

// Every content action forwards the SIGNED-IN USER's PocketBase token to a
// trusted endpoint inside PocketBase (pb_hooks/bsa_routes.pb.js). PocketBase
// derives organization/role from the database, validates the
// article/website/client relationship and the state transition, writes the
// version history + activity log in one transaction, and rejects anything
// else. The web app holds no superuser credentials.

function message(error: unknown): string {
  if (error instanceof OperationError && error.status < 500) return error.message;
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
    const { pb } = await requireUser();
    const result = await userOperation<{ article: { id: string } }>(pb, "content/generate", {
      websiteId,
      source: { kind, id: sourceId },
      inputs: {
        content_type: String(formData.get("content_type") ?? ""),
        primary_keyword: String(formData.get("primary_keyword") ?? ""),
        target_location: String(formData.get("target_location") ?? ""),
        recommended_url: String(formData.get("recommended_url") ?? ""),
        reason: String(formData.get("reason") ?? ""),
        language: String(formData.get("language") ?? ""),
        pause_after_brief: formData.get("pause_after_brief") === "on",
      },
    });
    articleId = result.article.id;
    refresh(articleId, websiteId);
  } catch (error) {
    return { error: message(error) };
  }
  redirect(`/articles/${articleId}`);
}

async function articleOperation(formData: FormData, path: string, extra: Record<string, unknown>, success: string): Promise<ContentActionState> {
  const articleId = String(formData.get("articleId") ?? "");
  const websiteId = String(formData.get("websiteId") ?? "");
  if (!articleId) return { error: "Missing article." };
  try {
    const { pb } = await requireUser();
    const result = await userOperation<Record<string, unknown>>(pb, path, { articleId, ...extra });
    refresh(articleId, websiteId);
    const jobId = result && typeof result.id === "string" && typeof result.mode === "string" ? result.id : undefined;
    return { success, jobId };
  } catch (error) {
    return { error: message(error) };
  }
}

export async function saveArticleAction(_prev: ContentActionState, formData: FormData): Promise<ContentActionState> {
  const articleId = String(formData.get("articleId") ?? "");
  const websiteId = String(formData.get("websiteId") ?? "");
  if (!articleId) return { error: "Missing article." };
  try {
    const { pb } = await requireUser();
    const res = await userOperation<{ changed: boolean; version?: number }>(pb, "content/edit", {
      articleId,
      reason: String(formData.get("change_reason") ?? ""),
      fields: {
        title: formData.get("title"), slug: formData.get("slug"), seo_title: formData.get("seo_title"),
        meta_description: formData.get("meta_description"), excerpt: formData.get("excerpt"), content: formData.get("content"),
      },
    });
    if (!res.changed) return { error: "No changes to save." };
    refresh(articleId, websiteId);
    return { success: "Saved as a new version. QA must re-run before approval." };
  } catch (error) {
    return { error: message(error) };
  }
}

export async function restoreVersionAction(_prev: ContentActionState, formData: FormData): Promise<ContentActionState> {
  const version = Number(formData.get("version"));
  return articleOperation(formData, "content/restore", { version }, `Version ${version} restored as a new version.`);
}

export async function approveArticleAction(_prev: ContentActionState, formData: FormData): Promise<ContentActionState> {
  return articleOperation(formData, "content/approve", {
    acknowledgeHighRisk: formData.get("ack_high_risk") === "on",
    acknowledgeWarnings: formData.get("ack_warnings") === "on",
  }, "Approved. Ready for Phase 5 — nothing was published.");
}

export async function rejectArticleAction(_prev: ContentActionState, formData: FormData): Promise<ContentActionState> {
  return articleOperation(formData, "content/reject", { reason: String(formData.get("reason") ?? "") }, "Rejected. The content remains stored.");
}

export async function requestRevisionAction(_prev: ContentActionState, formData: FormData): Promise<ContentActionState> {
  return articleOperation(formData, "content/revision", { instruction: String(formData.get("instruction") ?? "") }, "Revision queued.");
}

export async function retryGenerationAction(_prev: ContentActionState, formData: FormData): Promise<ContentActionState> {
  return articleOperation(formData, "content/retry", {}, "Retry queued. Completed stages are reused.");
}

export async function recheckArticleAction(_prev: ContentActionState, formData: FormData): Promise<ContentActionState> {
  return articleOperation(formData, "content/recheck", {}, "Fact check + QA queued for the current version.");
}

export async function continueAfterBriefAction(_prev: ContentActionState, formData: FormData): Promise<ContentActionState> {
  return articleOperation(formData, "content/continue", {}, "Drafting queued.");
}

export async function saveBriefAction(_prev: ContentActionState, formData: FormData): Promise<ContentActionState> {
  return articleOperation(formData, "content/brief", { brief: String(formData.get("brief") ?? "") }, "Brief saved. The outline will be regenerated from it.");
}
