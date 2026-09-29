"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/pocketbase/auth";
import { OperationError, userOperation } from "@/lib/pocketbase/operations";

// One-screen review (/review/[id]): edit, new image, recheck and publish —
// every write goes through the same PocketBase hook endpoints as the rest of
// the app (user token only; tenant + state checks live in pb_hooks).

export type ReviewState = { ok?: string; error?: string; needsReview?: boolean } | undefined;

function msg(e: unknown) {
  if (e instanceof OperationError && e.status < 500) return e.message;
  console.error("[review] action failed", e);
  return "Something went wrong. Try again.";
}
const str = (f: FormData, k: string) => String(f.get(k) ?? "");
function done(articleId: string) {
  revalidatePath(`/review/${articleId}`);
  revalidatePath(`/articles/${articleId}`);
  revalidatePath("/today");
  revalidatePath("/content");
}

/** Save edits (new version) and immediately re-run fact check + QA on it. */
export async function saveReviewAction(_p: ReviewState, f: FormData): Promise<ReviewState> {
  const articleId = str(f, "articleId");
  try {
    const { pb } = await requireUser();
    const r = await userOperation<{ changed: boolean; version?: number }>(pb, "content/edit", {
      articleId,
      reason: "Edited in review",
      fields: { title: f.get("title"), excerpt: f.get("excerpt"), content: f.get("content"), meta_description: f.get("meta_description") },
    });
    if (!r.changed) return { error: "No changes to save." };
    await userOperation(pb, "content/recheck", { articleId });
    done(articleId);
    return { ok: "Saved. Checking it again (about 1–2 minutes)…" };
  } catch (e) { return { error: msg(e) }; }
}

/** Ask for a different featured image (optionally describing it). */
export async function newImageAction(_p: ReviewState, f: FormData): Promise<ReviewState> {
  const articleId = str(f, "articleId");
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "content/image", { articleId, hint: str(f, "hint").trim() });
    done(articleId);
    return { ok: "Making a new image (about 1 minute)…" };
  } catch (e) { return { error: msg(e) }; }
}

/** AI rewrite with an instruction. */
export async function reviewRewriteAction(_p: ReviewState, f: FormData): Promise<ReviewState> {
  const articleId = str(f, "articleId");
  const instruction = str(f, "instruction").trim();
  if (instruction.length < 5) return { error: "Tell it what to change (e.g. “shorter, mention free estimate”)." };
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "content/revision", { articleId, instruction });
    done(articleId);
    return { ok: "Rewriting… this page updates by itself in a few minutes." };
  } catch (e) { return { error: msg(e) }; }
}

/** Approve THIS version and publish it in one click. */
export async function approvePublishAction(_p: ReviewState, f: FormData): Promise<ReviewState> {
  const articleId = str(f, "articleId");
  const websiteId = str(f, "websiteId");
  const reviewed = f.get("reviewed") === "on";
  try {
    const { pb } = await requireUser();
    const status = str(f, "status");
    if (status === "awaiting_approval") {
      await userOperation(pb, "content/approve", { articleId, acknowledgeHighRisk: reviewed, acknowledgeWarnings: reviewed });
    }
    try {
      const r = await userOperation<{ created: boolean }>(pb, "publishing/publish", { articleId, websiteId, confirm: true, acknowledgeHighRisk: reviewed });
      done(articleId);
      return { ok: r.created ? "Publishing now… it will be live in about 30 seconds." : "Already publishing." };
    } catch (e) {
      done(articleId);
      return { error: `Approved, but not published yet: ${msg(e)}` };
    }
  } catch (e) {
    const code = e instanceof OperationError ? e.code : "";
    if (code === "HIGH_RISK_REVIEW_REQUIRED" || code === "WARNINGS_NOT_ACKNOWLEDGED") {
      return { error: "Read it and tick “I read it and it’s correct” first.", needsReview: true };
    }
    return { error: msg(e) };
  }
}

export async function discardReviewAction(_p: ReviewState, f: FormData): Promise<ReviewState> {
  const articleId = str(f, "articleId");
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "content/reject", { articleId, reason: str(f, "reason") || "Discarded in review" });
    done(articleId);
    return { ok: "Discarded." };
  } catch (e) { return { error: msg(e) }; }
}

/** A generation step failed: run it again from where it stopped. */
export async function retryReviewAction(_p: ReviewState, f: FormData): Promise<ReviewState> {
  const articleId = str(f, "articleId");
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "content/retry", { articleId });
    done(articleId);
    return { ok: "Trying again… this page updates by itself." };
  } catch (e) { return { error: msg(e) }; }
}
