"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/pocketbase/auth";
import { OperationError, userOperation } from "@/lib/pocketbase/operations";

export type AnalyticsActionState = { error?: string; success?: string; code?: string; jobId?: string } | undefined;

// Every action forwards the signed-in user's token to /api/bsa/gsc/* or
// /api/bsa/analytics/* inside PocketBase, which enforces tenant + role.
// Phase 6 is read-only towards Google and never edits content.

function message(error: unknown): AnalyticsActionState {
  if (error instanceof OperationError && error.status < 500) return { error: error.message, code: error.code };
  if (error instanceof OperationError && error.code !== "INTERNAL") return { error: error.message, code: error.code };
  console.error("[analytics] action failed", error instanceof OperationError ? error.code : "unknown");
  return { error: "The operation failed. Please try again." };
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

function refresh(websiteId?: string) {
  if (websiteId) {
    revalidatePath(`/websites/${websiteId}/search-console`);
    revalidatePath(`/websites/${websiteId}/analytics`, "layout");
  }
  revalidatePath("/dashboard");
}

/** Starts Google OAuth: PocketBase creates a single-use state bound to user/org/website and returns the consent URL. */
export async function connectGoogleAction(_p: AnalyticsActionState, f: FormData): Promise<AnalyticsActionState> {
  let url = "";
  try {
    const { pb } = await requireUser();
    const r = await userOperation<{ url: string }>(pb, "gsc/oauth/start", { websiteId: str(f, "websiteId"), connectionId: str(f, "connectionId") || undefined });
    url = r.url;
  } catch (error) {
    return message(error);
  }
  if (!/^https:\/\/accounts\.google\.com\//.test(url) && process.env.NODE_ENV === "production") return { error: "Unexpected OAuth URL." };
  redirect(url);
}

export async function refreshPropertiesAction(_p: AnalyticsActionState, f: FormData): Promise<AnalyticsActionState> {
  const websiteId = str(f, "websiteId");
  try {
    const { pb } = await requireUser();
    const r = await userOperation<{ properties: number; accessLost: number }>(pb, "gsc/properties/refresh", { connectionId: str(f, "connectionId") });
    refresh(websiteId);
    return { success: `${r.properties} properties listed by Google${r.accessLost ? ` · ${r.accessLost} lost access` : ""}.` };
  } catch (error) {
    return message(error);
  }
}

export async function selectPropertyAction(_p: AnalyticsActionState, f: FormData): Promise<AnalyticsActionState> {
  const websiteId = str(f, "websiteId");
  try {
    const { pb } = await requireUser();
    const r = await userOperation<{ matchStatus: string; job: { id: string } | null }>(pb, "gsc/property/select", {
      websiteId, propertyId: str(f, "propertyId"), confirm: f.get("confirm") === "on", confirmDomain: str(f, "confirmDomain"), initialSync: f.get("initialSync") === "on",
    });
    refresh(websiteId);
    return { success: r.job ? "Property mapped. Initial sync (last 90 finalized days) queued." : "Property mapped.", jobId: r.job?.id };
  } catch (error) {
    return message(error);
  }
}

export async function syncNowAction(_p: AnalyticsActionState, f: FormData): Promise<AnalyticsActionState> {
  const websiteId = str(f, "websiteId");
  try {
    const { pb } = await requireUser();
    const r = await userOperation<{ job: { id: string; deduplicated: boolean } }>(pb, "gsc/sync", { websiteId, range: str(f, "range") || "28d", startDate: str(f, "startDate"), endDate: str(f, "endDate") });
    refresh(websiteId);
    return { success: r.job.deduplicated ? "A sync is already queued or running." : "Sync queued.", jobId: r.job.id };
  } catch (error) {
    return message(error);
  }
}

export async function cancelSyncAction(_p: AnalyticsActionState, f: FormData): Promise<AnalyticsActionState> {
  const websiteId = str(f, "websiteId");
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "gsc/sync/cancel", { jobId: str(f, "jobId") });
    refresh(websiteId);
    return { success: "Sync cancelled." };
  } catch (error) {
    return message(error);
  }
}

export async function disconnectAction(_p: AnalyticsActionState, f: FormData): Promise<AnalyticsActionState> {
  const websiteId = str(f, "websiteId");
  try {
    const { pb } = await requireUser();
    const r = await userOperation<{ revokedAtGoogle: boolean }>(pb, "gsc/disconnect", { connectionId: str(f, "connectionId"), confirm: f.get("confirm") === "on" });
    refresh(websiteId);
    return { success: `Disconnected${r.revokedAtGoogle ? " and revoked at Google" : ""}. Historical data is kept.` };
  } catch (error) {
    return message(error);
  }
}

export async function decideOpportunityAction(_p: AnalyticsActionState, f: FormData): Promise<AnalyticsActionState> {
  const websiteId = str(f, "websiteId");
  const id = str(f, "opportunityId");
  try {
    const { pb } = await requireUser();
    const r = await userOperation<{ status: string; contentOpportunity: string | null }>(pb, "analytics/opportunity/decide", {
      opportunityId: id, action: str(f, "decision"), note: str(f, "note"), createContentOpportunity: f.get("createContentOpportunity") === "on",
    });
    refresh(websiteId);
    revalidatePath(`/websites/${websiteId}/analytics/opportunities/${id}`);
    return { success: `Marked ${r.status}.${r.contentOpportunity ? " A Phase 3 content opportunity was proposed (status: proposed)." : ""}` };
  } catch (error) {
    return message(error);
  }
}

export async function qualityFlagAction(_p: AnalyticsActionState, f: FormData): Promise<AnalyticsActionState> {
  const websiteId = str(f, "websiteId");
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "analytics/quality-flag", { websiteId, flagId: str(f, "flagId") || undefined, startDate: str(f, "startDate"), endDate: str(f, "endDate"), reason: str(f, "reason"), exclude: f.get("exclude") !== "off" });
    refresh(websiteId);
    return { success: str(f, "flagId") ? "Flag removed." : "Date range flagged as unreliable." };
  } catch (error) {
    return message(error);
  }
}

export async function brandOverrideAction(_p: AnalyticsActionState, f: FormData): Promise<AnalyticsActionState> {
  const websiteId = str(f, "websiteId");
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "analytics/brand", { websiteId, normalizedQuery: str(f, "normalizedQuery"), brand: str(f, "brand") });
    refresh(websiteId);
    return { success: "Saved." };
  } catch (error) {
    return message(error);
  }
}

export async function analyticsSettingsAction(_p: AnalyticsActionState, f: FormData): Promise<AnalyticsActionState> {
  const websiteId = str(f, "websiteId");
  const num = (k: string) => (str(f, k) === "" ? undefined : Number(str(f, k)));
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "analytics/settings", {
      websiteId,
      settings: {
        low_ctr: { min_impressions: num("low_ctr.min_impressions"), ratio: num("low_ctr.ratio") },
        striking: { min_position: num("striking.min_position"), max_position: num("striking.max_position"), min_impressions: num("striking.min_impressions") },
        decay: { min_prev_clicks: num("decay.min_prev_clicks"), click_drop_pct: num("decay.click_drop_pct") },
        new_query: { min_impressions: num("new_query.min_impressions") },
        resolve_after_days: num("resolve_after_days"),
      },
    });
    refresh(websiteId);
    return { success: "Thresholds saved. They apply from the next sync." };
  } catch (error) {
    return message(error);
  }
}

export async function markNotificationAction(f: FormData): Promise<void> {
  const { pb } = await requireUser();
  await userOperation(pb, "notifications/read", { notificationId: str(f, "notificationId") }).catch(() => undefined);
  revalidatePath("/dashboard");
}
