"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/pocketbase/auth";
import { OperationError, userOperation } from "@/lib/pocketbase/operations";
import { saveSimpleSettings } from "@/lib/pocketbase/today";

export type TodayState = { ok?: string; error?: string; needsReview?: boolean } | undefined;

function msg(e: unknown) {
  if (e instanceof OperationError && e.status < 500) return e.message;
  console.error("[today] action failed", e);
  return "Something went wrong. Try again.";
}
const str = (f: FormData, k: string) => String(f.get(k) ?? "");
const done = () => { revalidatePath("/today"); revalidatePath("/content"); };

/** "Publish" = the HUMAN approves this exact version and presses publish. */
export async function publishPostAction(_p: TodayState, f: FormData): Promise<TodayState> {
  const articleId = str(f, "articleId");
  const websiteId = str(f, "websiteId");
  const reviewed = f.get("reviewed") === "on";
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "content/approve", { articleId, acknowledgeHighRisk: reviewed, acknowledgeWarnings: reviewed });
    try {
      const r = await userOperation<{ created: boolean }>(pb, "publishing/publish", { articleId, websiteId, confirm: true, acknowledgeHighRisk: reviewed });
      done();
      return { ok: r.created ? "Publishing now…" : "Already publishing." };
    } catch (e) {
      done();
      return { ok: `Approved. Not published yet: ${msg(e)}` };
    }
  } catch (e) {
    const code = e instanceof OperationError ? e.code : "";
    if (code === "HIGH_RISK_REVIEW_REQUIRED" || code === "WARNINGS_NOT_ACKNOWLEDGED") {
      return { error: code === "HIGH_RISK_REVIEW_REQUIRED" ? "Sensitive topic — read it and tick “I reviewed it”." : "The checker left notes — read it and tick “I reviewed it”.", needsReview: true };
    }
    return { error: msg(e) };
  }
}

export async function discardPostAction(_p: TodayState, f: FormData): Promise<TodayState> {
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "content/reject", { articleId: str(f, "articleId"), reason: str(f, "reason") || "Discarded from Today" });
    done();
    return { ok: "Discarded. Autopilot won't write this topic again." };
  } catch (e) { return { error: msg(e) }; }
}

export async function rewritePostAction(_p: TodayState, f: FormData): Promise<TodayState> {
  const instruction = str(f, "instruction").trim();
  if (instruction.length < 5) return { error: "Tell it what to change (e.g. “shorter, mention free quote”)." };
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "content/revision", { articleId: str(f, "articleId"), instruction });
    done();
    return { ok: "Rewriting… it will be back here in a few minutes." };
  } catch (e) { return { error: msg(e) }; }
}

export async function siteSettingsAction(_p: TodayState, f: FormData): Promise<TodayState> {
  const websiteId = str(f, "websiteId");
  const dailyOn = f.get("daily") === "on";
  const autoPublish = f.get("autopublish") === "on";
  try {
    const { pb } = await requireUser();
    await saveSimpleSettings(pb, websiteId, dailyOn, autoPublish);
    done();
    revalidatePath(`/websites/${websiteId}`);
    return { ok: !dailyOn ? "Saved — daily posts are off." : autoPublish ? "Saved — safe posts publish by themselves; the rest wait here." : "Saved — a new post every morning, waiting for your OK." };
  } catch (e) { return { error: msg(e) }; }
}

export async function writeNowAction(_p: TodayState, f: FormData): Promise<TodayState> {
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "autopilot/run", { websiteId: str(f, "websiteId") });
    done();
    return { ok: "Writing a post now…" };
  } catch (e) { return { error: msg(e) }; }
}
