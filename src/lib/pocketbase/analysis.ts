import "server-only";
import type PocketBase from "pocketbase";
import type { CrawlJob, WebsitePage, SeoIssue, WebsiteSnapshot, WebsiteChange, PageLink, WebsiteHealth } from "@/lib/types";

// ---------- READ helpers (used by server components, scoped by PB access rules) ----------

export async function listCrawlJobs(pb: PocketBase, websiteId: string): Promise<CrawlJob[]> {
  const res = await pb.collection("crawl_jobs").getList<CrawlJob>(1, 50, {
    filter: `website = "${websiteId}"`,
    sort: "-created_at",
  });
  return res.items;
}

export async function getLatestJob(pb: PocketBase, websiteId: string): Promise<CrawlJob | null> {
  try {
    const res = await pb.collection("crawl_jobs").getList<CrawlJob>(1, 1, {
      filter: `website = "${websiteId}"`,
      sort: "-created_at",
    });
    return res.items[0] ?? null;
  } catch {
    return null;
  }
}

export async function getLatestSnapshot(pb: PocketBase, websiteId: string): Promise<WebsiteSnapshot | null> {
  try {
    const res = await pb.collection("website_snapshots").getList<WebsiteSnapshot>(1, 1, {
      filter: `website = "${websiteId}"`,
      sort: "-created_at",
    });
    return res.items[0] ?? null;
  } catch {
    return null;
  }
}

export async function listPages(pb: PocketBase, websiteId: string): Promise<WebsitePage[]> {
  const res = await pb.collection("website_pages").getList<WebsitePage>(1, 200, {
    filter: `website = "${websiteId}"`,
    sort: "url",
  });
  return res.items;
}

export async function getPage(pb: PocketBase, pageId: string): Promise<WebsitePage | null> {
  try {
    return await pb.collection("website_pages").getOne<WebsitePage>(pageId);
  } catch {
    return null;
  }
}

export async function listIssues(
  pb: PocketBase,
  websiteId: string,
  { severity, category, status, page, issueType, q }:
    { severity?: string; category?: string; status?: string; page?: string; issueType?: string; q?: string } = {}
): Promise<SeoIssue[]> {
  const filters: string[] = [`website = "${websiteId}"`];
  if (status && status !== "all") filters.push(`status = "${status}"`);
  if (severity && severity !== "all") filters.push(`severity = "${severity}"`);
  if (category && category !== "all") filters.push(`category = "${category}"`);
  if (page) filters.push(`page = "${page}"`);
  if (issueType && issueType !== "all") filters.push(`issue_type = "${issueType}"`);
  const filter = filters.join(" && ");
  const res = await pb.collection("seo_issues").getList<SeoIssue>(1, 200, {
    filter,
    sort: "-last_detected_at",
    expand: "page",
  });
  let items = res.items;
  if (q) {
    const ql = q.toLowerCase();
    items = items.filter((i) => (i.title || "").toLowerCase().includes(ql) || (i.issue_type || "").toLowerCase().includes(ql));
  }
  return items;
}

export async function countOpenIssuesBySeverity(pb: PocketBase, websiteId: string): Promise<Record<string, number>> {
  const all = await listIssues(pb, websiteId, { status: "open" });
  const counts = { critical: 0, high: 0, medium: 0, low: 0, opportunity: 0, total: 0 };
  for (const i of all) {
    if (i.severity in counts) counts[i.severity]++;
    counts.total++;
  }
  return counts;
}

export async function listPageLinks(pb: PocketBase, sourcePageId: string): Promise<PageLink[]> {
  try {
    const res = await pb.collection("page_links").getList<PageLink>(1, 200, {
      filter: `source_page = "${sourcePageId}"`,
      sort: "-created_at",
    });
    return res.items;
  } catch {
    return [];
  }
}

export async function listLinkedPages(pb: PocketBase, pageId: string): Promise<PageLink[]> {
  try {
    const res = await pb.collection("page_links").getList<PageLink>(1, 200, {
      filter: `destination_page = "${pageId}"`,
      sort: "-created_at",
    });
    return res.items;
  } catch {
    return [];
  }
}

export async function listChanges(pb: PocketBase, websiteId: string): Promise<WebsiteChange[]> {
  try {
    const res = await pb.collection("website_changes").getList<WebsiteChange>(1, 50, {
      filter: `website = "${websiteId}"`,
      sort: "-detected_at",
    });
    return res.items;
  } catch {
    return [];
  }
}

/** Operational health summary derived from issues + snapshot (NOT a ranking score). */
export function deriveHealth(counts: Record<string, number>, hasAnalysis: boolean): WebsiteHealth {
  if (!hasAnalysis) return "not_analyzed";
  if ((counts.critical ?? 0) > 0) return "critical";
  if ((counts.high ?? 0) > 0) return "needs_attention";
  if (counts.total > 0) return "needs_attention";
  return "healthy";
}

// ---------- WRITE: only create crawl jobs from the app (worker does the rest) ----------

export async function createCrawlJob(
  pb: PocketBase,
  organization: string,
  websiteId: string,
  clientId: string,
  triggeredBy: string
): Promise<CrawlJob> {
  return await pb.collection("crawl_jobs").create<CrawlJob>({
    organization,
    client: clientId,
    website: websiteId,
    status: "queued",
    triggered_by: triggeredBy,
    created_at: new Date().toISOString(),
  });
}