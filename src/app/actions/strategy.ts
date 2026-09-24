"use server";

import { revalidatePath } from "next/cache";
import { requireUser, canWrite } from "@/lib/pocketbase/auth";
import { getWebsite } from "@/lib/pocketbase/websites";
import { OperationError, userOperation } from "@/lib/pocketbase/operations";
import {
  createStrategyJob,
  updateBusinessContext,
  type StrategyCollectionKey,
} from "@/lib/pocketbase/strategy";

// Every action here runs with the SIGNED-IN USER's PocketBase token.
// - strategy_jobs.createRule / clients.updateRule enforce tenant + role.
// - strategy record edits go through /api/bsa/strategy/record, which
//   re-validates the website/client/org relationship server-side.
// Activity is logged inside PocketBase (users cannot forge it).

export type StrategyActionState = { error?: string; success?: string; jobId?: string } | undefined;

const CONTEXT_FIELDS = [
  "industry",
  "description",
  "primary_language",
  "secondary_languages",
  "country",
  "primary_location",
  "service_areas",
  "target_audience",
  "brand_voice",
  "services",
  "products",
  "unique_selling_proposition",
  "primary_cta",
] as const;

const COLLECTION_KEYS = new Set<StrategyCollectionKey>([
  "keywords",
  "clusters",
  "opportunities",
  "cannibalization",
  "internalLinks",
  "plan",
]);

async function authorizedWebsite(websiteId: string) {
  const { pb, user } = await requireUser();
  if (!canWrite(user.role)) throw new Error("You do not have permission to edit strategy data.");
  if (!user.organization) throw new Error("Your account is not linked to an organization.");
  const website = await getWebsite(pb, websiteId);
  if (!website || website.organization !== user.organization) throw new Error("Website not found.");
  return { pb, user, website };
}

function strategyPath(websiteId: string): string {
  return `/websites/${websiteId}/strategy`;
}

export async function queueStrategyAction(
  _previous: StrategyActionState,
  formData: FormData
): Promise<StrategyActionState> {
  const websiteId = String(formData.get("websiteId") ?? "");
  if (!websiteId) return { error: "Missing website id." };

  try {
    const { pb, user, website } = await authorizedWebsite(websiteId);
    const job = await createStrategyJob(pb, user.organization!, website.client, website.id, user.id);
    revalidatePath(strategyPath(websiteId));
    return { success: "Strategy generation queued.", jobId: job.id };
  } catch (error) {
    console.error("[strategy] queue failed", error);
    return { error: error instanceof Error ? error.message : "Could not queue strategy generation." };
  }
}

export async function saveBusinessContextAction(
  _previous: StrategyActionState,
  formData: FormData
): Promise<StrategyActionState> {
  const websiteId = String(formData.get("websiteId") ?? "");
  if (!websiteId) return { error: "Missing website id." };

  try {
    const { pb, website } = await authorizedWebsite(websiteId);
    const values: Record<string, string> = {};
    for (const field of CONTEXT_FIELDS) values[field] = String(formData.get(field) ?? "").trim().slice(0, 5000);

    await updateBusinessContext(pb, website.client, values);
    revalidatePath(strategyPath(websiteId));
    revalidatePath(`/clients/${website.client}`);
    return { success: "Business context saved." };
  } catch (error) {
    console.error("[strategy] context update failed", error);
    return { error: error instanceof Error ? error.message : "Could not save business context." };
  }
}

export async function updateStrategyRecordAction(formData: FormData): Promise<void> {
  const websiteId = String(formData.get("websiteId") ?? "");
  const recordId = String(formData.get("recordId") ?? "");
  const collection = String(formData.get("collection") ?? "") as StrategyCollectionKey;
  const operation = String(formData.get("operation") ?? "");
  if (!websiteId || !recordId || !COLLECTION_KEYS.has(collection)) return;

  try {
    const { pb } = await requireUser();
    await userOperation(pb, "strategy/record", {
      websiteId,
      recordId,
      collection,
      operation,
      value: String(formData.get("value") ?? ""),
    });
    revalidatePath(strategyPath(websiteId));
  } catch (error) {
    if (!(error instanceof OperationError) || error.status >= 500) console.error("[strategy] record update failed", error);
  }
}
