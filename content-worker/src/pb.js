// PocketBase access for the content worker. All reads are scoped by website /
// client ids and every loaded record is re-checked against the job's tenant
// (defense in depth: a bad relation can never pull another client's data).
import { assertTenant } from "./context.js";

export async function createWorkerClient(url) {
  const { default: PocketBase } = await import("pocketbase");
  const pb = new PocketBase(url);
  pb.autoCancellation(false);
  return pb;
}

export async function authenticate(pb, email, password) {
  if (!email || !password) throw new Error("PB_ADMIN_EMAIL and PB_ADMIN_PASSWORD are required");
  await pb.collection("_superusers").authWithPassword(email, password);
}

export const esc = (value) => String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const nowIso = () => new Date().toISOString();

export async function claimNextJob(pb) {
  const result = await pb.collection("content_jobs").getList(1, 10, { filter: 'status = "queued"', sort: "created_at" });
  for (const candidate of result.items) {
    try {
      return await pb.collection("content_jobs").update(candidate.id, {
        status: "running", step: "building_context", progress: 5, started_at: nowIso(), error: "", error_code: "", updated_at: nowIso(),
      });
    } catch (error) {
      if (error?.status === 404 || error?.status === 409 || error?.status === 400) continue;
      throw error;
    }
  }
  return null;
}

export async function updateJob(pb, id, fields) {
  return pb.collection("content_jobs").update(id, { ...fields, updated_at: nowIso() });
}

export async function updateArticle(pb, id, fields) {
  return pb.collection("articles").update(id, { ...fields, updated_at: nowIso() });
}

async function one(pb, collection, id) {
  if (!id) return null;
  try { return await pb.collection(collection).getOne(id); } catch (error) { if (error?.status === 404) return null; throw error; }
}

export async function loadJobData(pb, job) {
  const article = await one(pb, "articles", job.article);
  if (!article) throw Object.assign(new Error("Article not found"), { code: "NOT_FOUND", retryable: false });
  const [organization, client, website] = [await one(pb, "organizations", job.organization), await one(pb, "clients", job.client), await one(pb, "websites", job.website)];
  if (!organization || !client || !website) throw Object.assign(new Error("Missing organization, client or website"), { code: "NOT_FOUND", retryable: false });
  const tenant = { organization: organization.id, client: client.id, website: website.id };
  if (client.organization !== organization.id || website.organization !== organization.id || website.client !== client.id) {
    throw Object.assign(new Error("Job tenant relationships are inconsistent"), { code: "TENANT_MISMATCH", retryable: false });
  }
  assertTenant({ job, article }, tenant);

  const byWebsite = `website = "${esc(website.id)}"`;
  const facts = await pb.collection("business_facts").getFullList({ filter: `${byWebsite} && client = "${esc(client.id)}"`, batch: 500 });
  const pages = await pb.collection("website_pages").getFullList({ filter: byWebsite, batch: 500, fields: "id,organization,client,website,url,normalized_url,path,title,h1,meta_description,headings,indexable,status_code,word_count,language" });
  const links = await pb.collection("page_links").getFullList({ filter: `${byWebsite} && link_type = "internal"`, batch: 1000, fields: "id,organization,client,website,destination_page" });
  const issues = (await pb.collection("seo_issues").getList(1, 60, { filter: `${byWebsite} && status = "open"`, sort: "-created_at" })).items;
  const opportunity = await one(pb, "content_opportunities", article.content_opportunity);
  const planItem = await one(pb, "content_plan_items", article.content_plan_item);
  const keyword = await one(pb, "keywords", article.keyword);
  const cluster = await one(pb, "topic_clusters", article.cluster);
  const clusterKeywords = cluster
    ? (await pb.collection("keywords").getList(1, 30, { filter: `${byWebsite} && cluster = "${esc(cluster.id)}"` })).items
    : [];
  // Duplicate/differentiation comparisons: SAME CLIENT ONLY.
  const otherArticles = await pb.collection("articles").getFullList({ filter: `client = "${esc(client.id)}" && id != "${esc(article.id)}" && status != "failed"`, batch: 200, fields: "id,organization,client,website,title,content,content_type,target_location" });
  assertTenant({ facts, pages, links, issues, opportunity, planItem, keyword, cluster, clusterKeywords }, tenant);
  assertTenant({ otherArticles }, { organization: organization.id, client: client.id });
  return { organization, client, website, article, facts, pages, links, issues, opportunity, planItem, keyword, cluster, clusterKeywords, otherArticles };
}

export async function recordUsage(pb, usage, { job, article }) {
  const cost = usage.estimatedCost;
  const known = cost !== null && cost !== undefined && Number.isFinite(Number(cost));
  const ts = nowIso();
  return pb.collection("ai_usage").create({
    organization: article.organization, client: article.client, website: article.website,
    article: article.id, content_job: job.id,
    task: usage.task, provider: usage.provider || "unknown", model: usage.model || "unknown",
    input_tokens: Math.max(0, Math.round(Number(usage.inputTokens) || 0)),
    output_tokens: Math.max(0, Math.round(Number(usage.outputTokens) || 0)),
    estimated_cost: known ? Number(cost) : 0,
    cost_status: known ? "calculated" : "pricing_not_configured",
    timestamp: ts, created_at: ts, updated_at: ts,
  });
}

/** Prior AI usage of this article's generation lifecycle (generate/continue jobs). */
export async function priorGenerationUsage(pb, article, currentJobId) {
  const jobs = await pb.collection("content_jobs").getFullList({ filter: `article = "${esc(article.id)}" && (mode = "generate" || mode = "continue") && id != "${esc(currentJobId)}"`, fields: "id" });
  if (!jobs.length) return { calls: 0, tokens: 0, cost: 0 };
  const filter = jobs.map((j) => `content_job = "${esc(j.id)}"`).join(" || ");
  const rows = await pb.collection("ai_usage").getFullList({ filter: `article = "${esc(article.id)}" && (${filter})`, fields: "input_tokens,output_tokens,estimated_cost,cost_status" });
  return rows.reduce((acc, r) => ({ calls: acc.calls + 1, tokens: acc.tokens + (r.input_tokens || 0) + (r.output_tokens || 0), cost: acc.cost + (r.cost_status === "calculated" ? r.estimated_cost || 0 : 0) }), { calls: 0, tokens: 0, cost: 0 });
}

export async function logActivity(pb, { article, action, metadata = {}, user }) {
  try {
    await pb.collection("activity_logs").create({
      organization: article.organization, client: article.client, website: article.website,
      user: user || "", action, entity_type: "article", entity_id: article.id, metadata, created_at: nowIso(),
    });
  } catch (error) {
    console.warn(`[content-worker] activity log failed (${action}): ${error?.message || error}`);
  }
}

export async function nextVersionNumber(pb, articleId) {
  const latest = await pb.collection("article_versions").getList(1, 1, { filter: `article = "${esc(articleId)}"`, sort: "-version" });
  return (Number(latest.items[0]?.version) || 0) + 1;
}

export async function createVersion(pb, article, fields, { changeType, reason, userId = "", label = "" }) {
  const version = await nextVersionNumber(pb, article.id);
  await pb.collection("article_versions").create({
    organization: article.organization, client: article.client, website: article.website, article: article.id,
    version, title: fields.title ?? article.title ?? "", content: fields.content ?? article.content ?? "",
    seo_title: fields.seo_title ?? article.seo_title ?? "", meta_description: fields.meta_description ?? article.meta_description ?? "",
    excerpt: fields.excerpt ?? article.excerpt ?? "", slug: fields.slug ?? article.slug ?? "",
    change_type: changeType, change_reason: String(reason || "").slice(0, 2000),
    created_by: userId || "", created_by_label: label, created_at: nowIso(),
  });
  return version;
}

export async function upsertSources(pb, article, sources) {
  const saved = [];
  for (const source of sources) {
    const existing = await pb.collection("research_sources").getList(1, 1, { filter: `article = "${esc(article.id)}" && normalized_url = "${esc(source.normalized_url)}"` });
    const payload = {
      organization: article.organization, client: article.client, website: article.website, article: article.id,
      url: source.url, normalized_url: source.normalized_url, title: source.title || "", publisher: source.publisher || "",
      source_type: source.source_type, retrieved_at: source.retrieved_at, relevance: source.relevance ?? 0, quality: source.quality ?? 0,
      notes: source.notes || "", excerpt: source.excerpt || "", query: source.query || "", verified_access: Boolean(source.verified_access),
      http_status: source.http_status || 0, provider: source.provider || "", created_at: nowIso(),
    };
    saved.push(existing.items[0] ? await pb.collection("research_sources").update(existing.items[0].id, payload) : await pb.collection("research_sources").create(payload));
  }
  return saved;
}

export async function replaceForVersion(pb, collection, article, version, rows) {
  const old = await pb.collection(collection).getFullList({ filter: `article = "${esc(article.id)}" && version = ${Number(version)}`, fields: "id" });
  for (const row of old) await pb.collection(collection).delete(row.id);
  const out = [];
  for (const row of rows) {
    out.push(await pb.collection(collection).create({ organization: article.organization, client: article.client, website: article.website, article: article.id, version, created_at: nowIso(), ...row }));
  }
  return out;
}
