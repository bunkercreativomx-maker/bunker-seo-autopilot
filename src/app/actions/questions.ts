"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/pocketbase/auth";
import { OperationError, userOperation } from "@/lib/pocketbase/operations";

export type AnswerState = { ok?: string; error?: string } | undefined;

const OK: Record<string, string> = {
  yes: "Saved. Posts can use this now.",
  no: "Saved. Posts will never say it.",
  skip: "Skipped.",
};

export async function answerQuestionAction(_p: AnswerState, f: FormData): Promise<AnswerState> {
  const answer = String(f.get("answer") ?? "");
  const websiteId = String(f.get("websiteId") ?? "");
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "facts/answer", { websiteId, key: String(f.get("key") ?? ""), answer, detail: String(f.get("detail") ?? "") });
    revalidatePath("/today");
    revalidatePath(`/websites/${websiteId}`);
    return { ok: OK[answer] ?? "Saved." };
  } catch (e) {
    if (e instanceof OperationError && e.status < 500) return { error: e.message };
    console.error("[questions] answer failed", e);
    return { error: "Couldn't save. Try again." };
  }
}
