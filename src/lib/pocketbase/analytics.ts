import "server-only";
import type PocketBase from "pocketbase";
import { userOperation } from "@/lib/pocketbase/operations";
import type {
  ArticlePerformance, ClientOverview, ConnectionInfo, Opportunity, OrgOverview, PageRow, Paged, PropertyOption, QueryDetail, QueryRow, Summary, SyncJob,
} from "@/lib/analytics/types";

// Aggregations run inside PocketBase (pb_hooks/bsa_gsc.js) as the signed-in
// user; the browser never receives raw daily rows. Collection reads use the
// user's session (org-scoped rules; hidden token fields are never serialized).
const q = (value: string) => `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

export type RangeInput = { range?: string; startDate?: string; endDate?: string };

export const getConnectionInfo = (pb: PocketBase, websiteId: string) =>
  safe(() => userOperation<ConnectionInfo>(pb, "gsc/connection", { websiteId }), null);

export const listPropertyOptions = (pb: PocketBase, websiteId: string, connectionId?: string) =>
  safe(() => userOperation<PropertyOption[]>(pb, "gsc/properties", { websiteId, connectionId }), [] as PropertyOption[]);

export const getSummary = (pb: PocketBase, websiteId: string, r: RangeInput) =>
  safe(() => userOperation<Summary>(pb, "analytics/summary", { websiteId, ...r }), null);

export const getQueries = (pb: PocketBase, websiteId: string, opts: RangeInput & Record<string, unknown>) =>
  safe(() => userOperation<Paged<QueryRow>>(pb, "analytics/queries", { websiteId, ...opts }), null);

export const getPages = (pb: PocketBase, websiteId: string, opts: RangeInput & Record<string, unknown>) =>
  safe(() => userOperation<Paged<PageRow>>(pb, "analytics/pages", { websiteId, ...opts }), null);

export const getQueryDetail = (pb: PocketBase, websiteId: string, query: string, r: RangeInput) =>
  safe(() => userOperation<QueryDetail>(pb, "analytics/query", { websiteId, query, ...r }), null);

export const getArticlePerformance = (pb: PocketBase, articleId: string) =>
  safe(() => userOperation<ArticlePerformance>(pb, "analytics/article", { articleId }), null);

export const getOrgOverview = (pb: PocketBase, range = "28d") =>
  safe(() => userOperation<OrgOverview>(pb, "analytics/organization", { range }), null);

export const getClientOverview = (pb: PocketBase, clientId: string, range = "28d") =>
  safe(() => userOperation<ClientOverview>(pb, "analytics/client", { clientId, range }), null);

export async function listSyncJobs(pb: PocketBase, filter: string, limit = 30): Promise<SyncJob[]> {
  return safe(async () => (await pb.collection("gsc_sync_jobs").getList<SyncJob>(1, limit, { filter, sort: "-created_at", expand: "website", requestKey: null })).items, []);
}

export async function getSyncJob(pb: PocketBase, id: string): Promise<SyncJob | null> {
  return safe(() => pb.collection("gsc_sync_jobs").getOne<SyncJob>(id, { requestKey: null }), null);
}

export async function listOpportunities(pb: PocketBase, websiteId: string, opts: { status?: string; type?: string; priority?: string; page?: number; perPage?: number } = {}) {
  const parts = [`website = ${q(websiteId)}`];
  if (opts.status && opts.status !== "all") parts.push(opts.status === "open" ? `(status = "new" || status = "reviewed")` : `status = ${q(opts.status)}`);
  if (opts.type) parts.push(`type = ${q(opts.type)}`);
  if (opts.priority) parts.push(`priority = ${q(opts.priority)}`);
  return safe(
    () => pb.collection("analytics_opportunities").getList<Opportunity>(opts.page ?? 1, opts.perPage ?? 50, { filter: parts.join(" && "), sort: "status,-last_detected_at", requestKey: null }),
    { items: [] as Opportunity[], totalItems: 0, page: 1, perPage: 50, totalPages: 0 },
  );
}

export async function getOpportunity(pb: PocketBase, id: string): Promise<Opportunity | null> {
  return safe(() => pb.collection("analytics_opportunities").getOne<Opportunity>(id, { expand: "decided_by,website", requestKey: null }), null);
}

export async function listNotifications(pb: PocketBase, limit = 10) {
  return safe(async () => (await pb.collection("notifications").getList<{ id: string; kind: string; severity: string; title: string; body: string; link: string; occurrences: number; read_at: string; updated_at: string }>(1, limit, { filter: `read_at = ""`, sort: "-updated_at", requestKey: null })).items, []);
}

/** Admin diagnostics: stored row counts (no secrets). */
export async function storageCounts(pb: PocketBase, websiteId: string) {
  const count = (col: string) => safe(async () => (await pb.collection(col).getList(1, 1, { filter: `website = ${q(websiteId)}`, fields: "id", requestKey: null })).totalItems, 0);
  const [site, page, query, queryPage, labels, opps] = await Promise.all(["gsc_site_daily", "gsc_page_daily", "gsc_query_daily", "gsc_query_page_daily", "gsc_query_labels", "analytics_opportunities"].map(count));
  return { site, page, query, queryPage, labels, opps };
}
