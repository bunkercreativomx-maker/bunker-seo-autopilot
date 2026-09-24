import "server-only";
import type PocketBase from "pocketbase";
import { userOperation } from "@/lib/pocketbase/operations";
import type { ArticlePublication, IntegrationView, PublicationEvent, PublishJob, PublishingWebsite, PublishPreview } from "@/lib/publishing/types";

// Session-client reads only: PocketBase rules scope rows to the user's org and
// hidden secret fields are never serialized to users.
const q = (value: string) => `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export async function getPublishingWebsite(pb: PocketBase, id: string): Promise<PublishingWebsite | null> {
  try { return await pb.collection("websites").getOne<PublishingWebsite>(id, { requestKey: null }); } catch { return null; }
}

export async function getIntegration(pb: PocketBase, websiteId: string): Promise<IntegrationView | null> {
  try {
    const r = await pb.collection("integrations").getList<IntegrationView>(1, 1, { filter: `website = ${q(websiteId)} && kind = "publishing"`, requestKey: null });
    return r.items[0] ?? null;
  } catch { return null; }
}

export async function listPublishJobs(pb: PocketBase, filter: string, limit = 50): Promise<PublishJob[]> {
  try {
    const r = await pb.collection("publish_jobs").getList<PublishJob>(1, limit, { filter, sort: "-created_at", expand: "website,article", fields: "*,expand.website.name,expand.article.title", requestKey: null });
    return r.items;
  } catch { return []; }
}

export async function getPublication(pb: PocketBase, articleId: string): Promise<ArticlePublication | null> {
  try {
    const r = await pb.collection("article_publications").getList<ArticlePublication>(1, 1, { filter: `article = ${q(articleId)}`, expand: "website,published_by", requestKey: null });
    return r.items[0] ?? null;
  } catch { return null; }
}

export async function listPublicationEvents(pb: PocketBase, articleId: string): Promise<PublicationEvent[]> {
  try {
    const r = await pb.collection("publication_events").getList<PublicationEvent>(1, 100, { filter: `article = ${q(articleId)}`, sort: "-created_at", expand: "actor", fields: "id,operation,status,version,public_url,created_at,created,details,expand.actor.name,expand.actor.email", requestKey: null });
    return r.items;
  } catch { return []; }
}

export async function publishPreview(pb: PocketBase, articleId: string, websiteId: string): Promise<PublishPreview | null> {
  try { return await userOperation<PublishPreview>(pb, "publishing/preview", { articleId, websiteId }); } catch { return null; }
}

export async function rollbackCandidates(pb: PocketBase, articleId: string): Promise<Array<{ event: string; version: number; hash: string; at: string; title: string }>> {
  try { return (await userOperation<{ versions: Array<{ event: string; version: number; hash: string; at: string; title: string }> }>(pb, "publishing/versions", { articleId })).versions ?? []; } catch { return []; }
}

export async function publishingOverview(pb: PocketBase) {
  const jobs = await listPublishJobs(pb, "", 200);
  let websites: PublishingWebsite[] = [];
  let publications: ArticlePublication[] = [];
  try { websites = (await pb.collection("websites").getList<PublishingWebsite>(1, 200, { requestKey: null })).items; } catch { websites = []; }
  try { publications = (await pb.collection("article_publications").getList<ArticlePublication>(1, 500, { requestKey: null })).items; } catch { publications = []; }
  const active = ["queued", "validating", "publishing", "verifying", "unpublishing"];
  return {
    queue: jobs.filter((j) => active.includes(j.status)).length,
    published: publications.filter((p) => p.status === "published").length,
    failed: jobs.filter((j) => j.status === "failed" || j.status === "verification_required").length,
    connectionErrors: websites.filter((w) => w.publishing_enabled && w.connection_status && !["connected", "not_configured"].includes(w.connection_status)).length,
    recent: jobs.slice(0, 8),
  };
}
