import "server-only";
import type PocketBase from "pocketbase";
import type {
  CannibalizationIssue,
  ContentOpportunity,
  InternalLinkOpportunity,
  StrategyData,
  StrategyJob,
  StrategyKeyword,
  StrategyPlanItem,
  StrategyVersion,
  TopicCluster,
  WebsitePage,
} from "@/lib/types";

export const STRATEGY_COLLECTIONS = {
  jobs: "strategy_jobs",
  keywords: "keywords",
  clusters: "topic_clusters",
  opportunities: "content_opportunities",
  cannibalization: "cannibalization_issues",
  // Internal-link recommendations are content opportunities with type internal_link.
  internalLinks: "content_opportunities",
  plan: "content_plan_items",
} as const;

export type StrategyCollectionKey = Exclude<keyof typeof STRATEGY_COLLECTIONS, "jobs">;

function websiteFilter(websiteId: string): string {
  return `website = "${websiteId.replaceAll('"', '\\"')}"`;
}

async function listForWebsite<T>(
  pb: PocketBase,
  collection: string,
  websiteId: string,
  sort = "-created_at",
  expand?: string,
  extraFilter?: string
): Promise<T[]> {
  try {
    const result = await pb.collection(collection).getList<T>(1, 500, {
      filter: [websiteFilter(websiteId), extraFilter].filter(Boolean).join(" && "),
      sort,
      expand,
      requestKey: null,
    });
    return result.items;
  } catch (error) {
    console.error(`[strategy] could not read ${collection}`, error);
    return [];
  }
}

function internalLinkFromOpportunity(item: ContentOpportunity): InternalLinkOpportunity {
  const existingPage = item.expand?.existing_page as WebsitePage | undefined;
  const keyword = item.expand?.keyword as StrategyKeyword | undefined;
  return {
    ...item,
    source_page: item.existing_page,
    source_url: existingPage?.url,
    target_url: item.recommended_url,
    anchor_text: keyword?.keyword,
    reason: item.reason,
  };
}

/** Read strategy records sequentially to avoid PocketBase SDK auto-cancellation. */
export async function getStrategyData(pb: PocketBase, websiteId: string): Promise<StrategyData> {
  const jobs = await listForWebsite<StrategyJob>(pb, STRATEGY_COLLECTIONS.jobs, websiteId);
  const versions = await listForWebsite<StrategyVersion>(pb, "strategy_versions", websiteId, "-version");
  const latestVersion = versions[0];
  if (!latestVersion) return { latestJob: jobs[0] ?? null, keywords: [], clusters: [], opportunities: [], cannibalization: [], internalLinks: [], plan: [] };

  const versionFilter = `strategy_version = "${latestVersion.id}"`;
  const keywords = await listForWebsite<StrategyKeyword>(pb, STRATEGY_COLLECTIONS.keywords, websiteId, "-priority", "cluster", versionFilter);
  const clusters = await listForWebsite<TopicCluster>(pb, STRATEGY_COLLECTIONS.clusters, websiteId, "name", "pillar_keyword,pillar_page", versionFilter);
  const rawOpportunities = await listForWebsite<ContentOpportunity>(pb, STRATEGY_COLLECTIONS.opportunities, websiteId, "-priority", "keyword,cluster,existing_page", versionFilter);
  const cannibalization = await listForWebsite<CannibalizationIssue>(pb, STRATEGY_COLLECTIONS.cannibalization, websiteId, "-severity", "pages", versionFilter);
  const plan = await listForWebsite<StrategyPlanItem>(pb, STRATEGY_COLLECTIONS.plan, websiteId, "scheduled_period,-priority", "keyword,cluster,existing_page,opportunity", versionFilter);

  const keywordCounts = new Map<string, number>();
  for (const keyword of keywords) {
    if (keyword.cluster) keywordCounts.set(keyword.cluster, (keywordCounts.get(keyword.cluster) ?? 0) + 1);
  }
  for (const cluster of clusters) cluster.keyword_count = keywordCounts.get(cluster.id) ?? 0;

  const internalLinks = rawOpportunities
    .filter((item) => item.opportunity_type === "internal_link")
    .map(internalLinkFromOpportunity);
  const opportunities = rawOpportunities.filter((item) => item.opportunity_type !== "internal_link");

  return { latestJob: jobs[0] ?? null, keywords, clusters, opportunities, cannibalization, internalLinks, plan };
}

export async function getStrategyJob(pb: PocketBase, jobId: string): Promise<StrategyJob | null> {
  try {
    return await pb.collection(STRATEGY_COLLECTIONS.jobs).getOne<StrategyJob>(jobId, { requestKey: null });
  } catch {
    return null;
  }
}

/** Queue one strategy job at a time for a website. */
export async function createStrategyJob(
  pb: PocketBase,
  organization: string,
  clientId: string,
  websiteId: string,
  triggeredBy: string
): Promise<StrategyJob> {
  const active = await pb.collection(STRATEGY_COLLECTIONS.jobs).getList<StrategyJob>(1, 1, {
    filter: `${websiteFilter(websiteId)} && (status = "queued" || status = "running")`,
    sort: "-created_at",
    requestKey: null,
  });
  if (active.items[0]) return active.items[0];

  const now = new Date().toISOString();
  return await pb.collection(STRATEGY_COLLECTIONS.jobs).create<StrategyJob>({
    organization,
    client: clientId,
    website: websiteId,
    status: "queued",
    step: "queued",
    progress: 0,
    triggered_by: triggeredBy,
    created_at: now,
    updated_at: now,
  }, { requestKey: null });
}

export async function updateStrategyRecord(
  pb: PocketBase,
  collection: StrategyCollectionKey,
  recordId: string,
  data: Record<string, unknown>
): Promise<void> {
  await pb.collection(STRATEGY_COLLECTIONS[collection]).update(recordId, data, { requestKey: null });
}

export async function updateBusinessContext(
  pb: PocketBase,
  clientId: string,
  data: Record<string, string>
): Promise<void> {
  await pb.collection("clients").update(clientId, data, { requestKey: null });
}
