import { keywordKey } from "./normalize.js";

export const DEFAULT_COLLECTIONS = Object.freeze({
  keywords: "keywords", clusters: "topic_clusters", mappings: "keyword_page_mappings",
  opportunities: "content_opportunities", cannibalization: "cannibalization_issues",
  plans: "content_plans", actions: "content_plan_items", versions: "strategy_versions", ai_usage: "ai_usage",
});

export async function createWorkerClient(url) {
  const { default: PocketBase } = await import("pocketbase");
  return new PocketBase(url);
}
export async function authenticate(pb, email, password) {
  if (!email || !password) throw new Error("PB_ADMIN_EMAIL and PB_ADMIN_PASSWORD are required");
  await pb.collection("_superusers").authWithPassword(email, password);
}
const escapeFilter = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export async function claimNextJob(pb) {
  const result = await pb.collection("strategy_jobs").getList(1, 10, { filter: 'status = "queued"', sort: "created_at", requestKey: null });
  for (const candidate of result.items) {
    try {
      return await pb.collection("strategy_jobs").update(candidate.id, { status: "running", step: "loading_inputs", progress: 5, started_at: new Date().toISOString(), error: "", updated_at: new Date().toISOString() }, { requestKey: null });
    } catch (error) {
      if (error?.status === 404 || error?.status === 409) continue;
      throw error;
    }
  }
  return null;
}

async function safeOne(pb, collection, id) {
  if (!id) return null;
  try { return await pb.collection(collection).getOne(id, { requestKey: null }); } catch { return null; }
}

function latestManual(records, keyOf) {
  const output = new Map();
  for (const record of records.filter((item) => item.manual_override)) {
    const key = keyOf(record);
    if (key && !output.has(key)) output.set(key, { ...record, key });
  }
  return [...output.values()];
}

export async function loadJobInput(pb, job, collections = DEFAULT_COLLECTIONS) {
  if (job.status !== "running") throw new Error("Strategy job is not running");
  const [client, website, organization] = await Promise.all([
    safeOne(pb, "clients", job.client), safeOne(pb, "websites", job.website), safeOne(pb, "organizations", job.organization),
  ]);
  if (!client || !website || !organization) throw new Error("Missing client, website, or organization");
  if (client.organization !== organization.id || website.organization !== organization.id || website.client !== client.id) throw new Error("Job tenant relationships are inconsistent");
  const filter = `website = "${escapeFilter(website.id)}"`;
  const read = (name, extra = {}) => pb.collection(name).getFullList({ filter, sort: "-created_at", requestKey: null, ...extra });
  const [pages, links, issues, facts, oldKeywords, oldClusters, oldMappings, oldOpportunities, oldCannibalization, oldPlans, oldActions] = await Promise.all([
    read("website_pages"), read("page_links"), read("seo_issues"), read("business_facts"), read(collections.keywords),
    read(collections.clusters), read(collections.mappings, { expand: "keyword" }), read(collections.opportunities),
    read(collections.cannibalization), read(collections.plans), read(collections.actions),
  ]);
  if (!pages.length) throw new Error("No crawler pages found; run a crawl before generating strategy");
  const stableEvidenceKey = (record) => record.evidence?.stable_key || record.evidence?.key;
  const existing = {
    keywords: latestManual(oldKeywords, (r) => keywordKey(r.normalized_keyword || r.keyword)),
    clusters: latestManual(oldClusters, (r) => keywordKey(r.primary_topic || r.name)),
    mappings: latestManual(oldMappings, (r) => keywordKey(r.expand?.keyword?.normalized_keyword || r.expand?.keyword?.keyword || "")),
    gaps: latestManual(oldOpportunities.filter((r) => r.opportunity_type !== "internal_link"), stableEvidenceKey),
    internal_links: latestManual(oldOpportunities.filter((r) => r.opportunity_type === "internal_link"), stableEvidenceKey),
    cannibalization: latestManual(oldCannibalization, (r) => keywordKey(r.keyword_group)),
    plans: latestManual(oldPlans, () => "90-day-roadmap"),
    actions: latestManual(oldActions, stableEvidenceKey),
  };
  let previousVersion = 0;
  const versions = await pb.collection(collections.versions).getList(1, 1, { filter, sort: "-version", requestKey: null });
  previousVersion = Number(versions.items[0]?.version) || 0;
  return { client, website, organization, pages, links, issues, facts, existing, previous_version: previousVersion };
}

export async function updateJob(pb, id, fields) {
  return pb.collection("strategy_jobs").update(id, { ...fields, updated_at: new Date().toISOString() }, { requestKey: null });
}
