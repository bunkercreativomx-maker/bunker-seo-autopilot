import "server-only";
import type PocketBase from "pocketbase";
import { userOperation } from "@/lib/pocketbase/operations";

export type QuickQuestion = {
  key: string;
  kind: "confirm" | "bank";
  websiteId: string;
  websiteName: string;
  label: string;
  value: string;
  q: string;
  hint: string;
  input: "none" | "text" | "number";
  optional?: boolean;
  placeholder?: string;
  allowNo: boolean;
  sourceUrl?: string;
};

/** Yes/No questions that turn owner knowledge into verified facts (pb_hooks/bsa_facts.js). */
export async function loadQuestions(pb: PocketBase, websiteId?: string): Promise<QuickQuestion[]> {
  try {
    const r = await userOperation<{ questions: QuickQuestion[] }>(pb, "facts/questions", websiteId ? { websiteId } : {});
    return r.questions ?? [];
  } catch (e) {
    console.error("[questions] load failed", e);
    return [];
  }
}
