"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/pocketbase/auth";
import { OperationError, userOperation } from "@/lib/pocketbase/operations";

export type PublishingActionState = { error?: string; success?: string; secret?: string; code?: string } | undefined;

// Every publishing action forwards the signed-in user's token to
// /api/bsa/publishing/* inside PocketBase, which validates tenant, role,
// approval + version lock, idempotency and slug conflicts, then only QUEUES a
// job. The independent bunker-seo-publisher worker performs outbound requests.

function message(error: unknown): PublishingActionState {
  if (error instanceof OperationError && error.status < 500) return { error: error.message, code: error.code };
  console.error("[publishing] action failed", error instanceof OperationError ? error.code : "unknown");
  return { error: "The operation failed. Please try again." };
}

function refresh(websiteId?: string, articleId?: string) {
  if (websiteId) revalidatePath(`/websites/${websiteId}/publishing`);
  if (articleId) revalidatePath(`/articles/${articleId}`);
  revalidatePath("/content");
  revalidatePath("/dashboard");
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

export async function savePublishingConfigAction(_p: PublishingActionState, f: FormData): Promise<PublishingActionState> {
  const websiteId = str(f, "websiteId");
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "publishing/config", {
      websiteId,
      publisherType: str(f, "publisherType"),
      publishingMode: str(f, "publishingMode") || "manual",
      environment: str(f, "environment") || "staging",
      enabled: f.get("enabled") === "on",
      allowedDomains: str(f, "allowedDomains"),
      baseUrl: str(f, "baseUrl"),
      blogPath: str(f, "blogPath") || "/blog",
      apiEndpoint: str(f, "apiEndpoint"),
      revalidateUrl: str(f, "revalidateUrl"),
      sitemapUrl: str(f, "sitemapUrl"),
      verifySitemap: f.get("verifySitemap") === "on",
      autoRevalidate: f.get("autoRevalidate") === "on",
      username: str(f, "username"),
      wordpressStatus: str(f, "wordpressStatus"),
      wordpressSeoPlugin: str(f, "wordpressSeoPlugin"),
    });
    refresh(websiteId);
    return { success: "Publishing configuration saved. Run Test Connection." };
  } catch (e) { return message(e); }
}

export async function saveSecretAction(_p: PublishingActionState, f: FormData): Promise<PublishingActionState> {
  const websiteId = str(f, "websiteId");
  const generate = f.get("generate") === "1";
  try {
    const { pb } = await requireUser();
    const r = await userOperation<{ last4: string; secret?: string; rotated: boolean }>(pb, "publishing/secret", {
      websiteId, generate, secret: generate ? undefined : String(f.get("secret") ?? ""), graceHours: Number(f.get("graceHours") || 0),
    });
    refresh(websiteId);
    // A generated secret is shown ONCE so it can be set on the target site; it is never retrievable later.
    return { success: `Secret ${r.rotated ? "rotated" : "saved"} (…${r.last4}).`, secret: r.secret };
  } catch (e) { return message(e); }
}

export async function testConnectionAction(_p: PublishingActionState, f: FormData): Promise<PublishingActionState> {
  const websiteId = str(f, "websiteId");
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "publishing/test", { websiteId });
    refresh(websiteId);
    return { success: "Connection test queued. Refresh in a few seconds." };
  } catch (e) { return message(e); }
}

export async function publishArticleAction(_p: PublishingActionState, f: FormData): Promise<PublishingActionState> {
  const articleId = str(f, "articleId");
  const websiteId = str(f, "websiteId");
  if (f.get("confirm") !== "on") return { error: "Confirm that you reviewed the publication details." };
  try {
    const { pb } = await requireUser();
    const r = await userOperation<{ created: boolean; operation: string }>(pb, "publishing/publish", {
      articleId, websiteId, confirm: true, operation: str(f, "operation") || undefined, acknowledgeHighRisk: f.get("ack_high_risk") === "on",
    });
    refresh(websiteId, articleId);
    return { success: r.created ? `${r.operation === "update" ? "Update" : "Publication"} queued.` : "Already queued — no duplicate created." };
  } catch (e) { return message(e); }
}

export async function unpublishArticleAction(_p: PublishingActionState, f: FormData): Promise<PublishingActionState> {
  const articleId = str(f, "articleId");
  if (f.get("confirm") !== "on") return { error: "Confirm the unpublish." };
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "publishing/unpublish", { articleId, confirm: true });
    refresh(str(f, "websiteId"), articleId);
    return { success: "Unpublish queued." };
  } catch (e) { return message(e); }
}

export async function verifyPublicationAction(_p: PublishingActionState, f: FormData): Promise<PublishingActionState> {
  const articleId = str(f, "articleId");
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "publishing/verify", { articleId });
    refresh(str(f, "websiteId"), articleId);
    return { success: "Verification queued." };
  } catch (e) { return message(e); }
}

export async function rollbackPublicationAction(_p: PublishingActionState, f: FormData): Promise<PublishingActionState> {
  const articleId = str(f, "articleId");
  if (f.get("confirm") !== "on") return { error: "Confirm the rollback." };
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "publishing/rollback", { articleId, eventId: str(f, "eventId"), confirm: true });
    refresh(str(f, "websiteId"), articleId);
    return { success: "Rollback queued." };
  } catch (e) { return message(e); }
}

export async function cancelPublishJobAction(_p: PublishingActionState, f: FormData): Promise<PublishingActionState> {
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "publishing/cancel", { jobId: str(f, "jobId") });
    refresh(str(f, "websiteId"), str(f, "articleId"));
    return { success: "Job cancelled." };
  } catch (e) { return message(e); }
}
