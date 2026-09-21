"use server";

import { revalidatePath } from "next/cache";
import { requireUser, canWrite } from "@/lib/pocketbase/auth";
import { createBaseClient, adminAuth } from "@/lib/pocketbase/client";
import { getWebsite } from "@/lib/pocketbase/websites";
import {
  createStrategyJob,
  STRATEGY_COLLECTIONS,
  updateBusinessContext,
  updateStrategyRecord,
  type StrategyCollectionKey,
} from "@/lib/pocketbase/strategy";


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
  return { user, website };
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
    const { user, website } = await authorizedWebsite(websiteId);
    const admin = createBaseClient();
    await adminAuth(admin);
    const job = await createStrategyJob(admin, user.organization!, website.client, website.id, user.id);
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
    const { website } = await authorizedWebsite(websiteId);
    const values: Record<string, string> = {};
    for (const field of CONTEXT_FIELDS) values[field] = String(formData.get(field) ?? "").trim().slice(0, 5000);

    const admin = createBaseClient();
    await adminAuth(admin);
    await updateBusinessContext(admin, website.client, values);
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
    const { user, website } = await authorizedWebsite(websiteId);
    const admin = createBaseClient();
    await adminAuth(admin);

    const record = await admin.collection(STRATEGY_COLLECTIONS[collection]).getOne<{
      organization: string;
      client: string;
      website: string;
      manual_fields?: string[];
    }>(recordId, { requestKey: null });
    if (
      record.organization !== user.organization ||
      record.client !== website.client ||
      record.website !== website.id
    ) {
      throw new Error("Strategy record not found.");
    }

    const data: Record<string, unknown> = {};
    let changedField = "status";
    if (operation === "approve") data.status = collection === "cannibalization" ? "reviewed" : "approved";
    else if (operation === "ignore") {
      data.status = collection === "clusters" ? "archived" : collection === "opportunities" || collection === "internalLinks" ? "skipped" : "ignored";
    }
    else if (operation === "skip" && collection === "plan") data.status = "skipped";
    else if (operation === "change_intent") {
      const value = String(formData.get("value") ?? "");
      if (!["informational", "navigational", "commercial", "transactional", "local", "mixed"].includes(value)) return;
      data.intent = value;
      changedField = "intent";
    } else if (operation === "change_cluster") {
      data.cluster = String(formData.get("value") ?? "").slice(0, 200);
      changedField = "cluster";
    } else if (operation === "change_priority") {
      const value = String(formData.get("value") ?? "");
      if (!["critical", "high", "medium", "low"].includes(value)) return;
      data.priority = value;
      changedField = "priority";
    } else if (operation === "change_action") {
      const value = String(formData.get("value") ?? "").trim();
      if (collection === "cannibalization") {
        changedField = "recommended_action";
        data[changedField] = value.slice(0, 1000);
      } else if (collection === "opportunities" || collection === "internalLinks") {
        if (!["create", "optimize", "expand", "merge", "internal_link", "location", "service", "refresh", "ignore"].includes(value)) return;
        changedField = "opportunity_type";
        data[changedField] = value;
      } else return;
    } else return;

    data.manual_override = true;
    data.manual_fields = [...new Set([...(record.manual_fields ?? []), changedField])];
    data.overridden_by = user.id;
    data.overridden_at = new Date().toISOString();
    data.updated_at = new Date().toISOString();

    await updateStrategyRecord(admin, collection, recordId, data);
    revalidatePath(strategyPath(websiteId));
  } catch (error) {
    console.error("[strategy] record update failed", error);
  }
}
