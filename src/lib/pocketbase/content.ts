import "server-only";
import type PocketBase from "pocketbase";
import { articleUsage } from "@/lib/content/core";
import type {
  Article, ArticleClaim, ArticleInternalLink, ArticleQaReport, ArticleResearch, ArticleVersion,
  ContentJob, ContentUsage, ResearchSource,
} from "@/lib/content/types";

// All reads use the SESSION client: PocketBase list/view rules restrict rows to
// the user's organization, and callers additionally scope by client/website.
const q = (value: string) => `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export type ContentFilters = { client?: string; website?: string; content_type?: string; status?: string; language?: string };

export async function listArticles(pb: PocketBase, filters: ContentFilters = {}, limit = 200): Promise<Article[]> {
  const parts: string[] = [];
  if (filters.client) parts.push(`client = ${q(filters.client)}`);
  if (filters.website) parts.push(`website = ${q(filters.website)}`);
  if (filters.content_type) parts.push(`content_type = ${q(filters.content_type)}`);
  if (filters.status) parts.push(`status = ${q(filters.status)}`);
  if (filters.language) parts.push(`language = ${q(filters.language)}`);
  try {
    const res = await pb.collection("articles").getList<Article>(1, limit, {
      filter: parts.join(" && "),
      sort: "-updated",
      expand: "client,website",
      fields: "id,organization,client,website,content_type,title,primary_keyword,status,language,qa_status,flags,high_risk,updated,created,generation_key,content_opportunity,content_plan_item,expand.client.business_name,expand.website.name,expand.website.domain",
      requestKey: null,
    });
    return res.items;
  } catch (error) {
    console.error("[content] list failed", error);
    return [];
  }
}

export async function getArticle(pb: PocketBase, id: string): Promise<Article | null> {
  try {
    return await pb.collection("articles").getOne<Article>(id, { expand: "client,website,approved_by", requestKey: null });
  } catch {
    return null;
  }
}

async function forArticle<T>(pb: PocketBase, collection: string, articleId: string, sort: string, extra = ""): Promise<T[]> {
  try {
    return await pb.collection(collection).getFullList<T>({ filter: [`article = ${q(articleId)}`, extra].filter(Boolean).join(" && "), sort, requestKey: null });
  } catch (error) {
    console.error(`[content] could not read ${collection}`, error);
    return [];
  }
}

export type ArticleBundle = {
  article: Article;
  versions: ArticleVersion[];
  jobs: ContentJob[];
  research: ArticleResearch | null;
  sources: ResearchSource[];
  claims: ArticleClaim[];
  links: ArticleInternalLink[];
  qa: ArticleQaReport[];
  usage: ContentUsage;
};

/** Sequential reads (the SDK auto-cancels duplicate concurrent requests). */
export async function getArticleBundle(pb: PocketBase, id: string): Promise<ArticleBundle | null> {
  const article = await getArticle(pb, id);
  if (!article) return null;
  const versions = await forArticle<ArticleVersion>(pb, "article_versions", id, "-version");
  const jobs = await forArticle<ContentJob>(pb, "content_jobs", id, "-created");
  const research = (await forArticle<ArticleResearch>(pb, "article_research", id, "-created"))[0] ?? null;
  const sources = await forArticle<ResearchSource>(pb, "research_sources", id, "-quality");
  const version = Number(article.current_version || 0);
  let claims = await forArticle<ArticleClaim>(pb, "article_claims", id, "-risk_level", `version = ${version}`);
  if (!claims.length) claims = await forArticle<ArticleClaim>(pb, "article_claims", id, "-version");
  let links = await forArticle<ArticleInternalLink>(pb, "article_internal_links", id, "status", `version = ${version}`);
  if (!links.length) links = await forArticle<ArticleInternalLink>(pb, "article_internal_links", id, "-version");
  const qa = await forArticle<ArticleQaReport>(pb, "article_qa_reports", id, "-created");
  const usage = await articleUsage(pb, id) as ContentUsage;
  return { article, versions, jobs, research, sources, claims, links, qa, usage };
}

export async function getContentJob(pb: PocketBase, jobId: string): Promise<ContentJob | null> {
  try {
    return await pb.collection("content_jobs").getOne<ContentJob>(jobId, { requestKey: null });
  } catch {
    return null;
  }
}

/** Existing drafts for strategy cards ("Open Draft" instead of "Generate Content"). */
export async function contentLinksForWebsite(pb: PocketBase, websiteId: string): Promise<{ byKey: Record<string, { id: string; status: string }>; byOpportunity: Record<string, { id: string; status: string }> }> {
  try {
    const rows = await pb.collection("articles").getFullList<Pick<Article, "id" | "status" | "generation_key" | "content_opportunity">>({
      filter: `website = ${q(websiteId)}`, fields: "id,status,generation_key,content_opportunity", sort: "-created", requestKey: null,
    });
    const byKey: Record<string, { id: string; status: string }> = {};
    const byOpportunity: Record<string, { id: string; status: string }> = {};
    for (const row of rows) {
      const ref = { id: row.id, status: row.status };
      if (row.generation_key) byKey[row.generation_key] = ref;
      if (row.content_opportunity && row.status !== "rejected" && !byOpportunity[row.content_opportunity]) byOpportunity[row.content_opportunity] = ref;
    }
    return { byKey, byOpportunity };
  } catch {
    return { byKey: {}, byOpportunity: {} };
  }
}
