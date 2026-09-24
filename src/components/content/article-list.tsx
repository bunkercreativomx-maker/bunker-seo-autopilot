import Link from "next/link";
import { Badge, Card, EmptyState } from "@/components/ui";
import { formatRelative } from "@/lib/format";
import { ARTICLE_STATUS_LABELS, CONTENT_TYPE_LABELS, type Article, type ArticleStatus } from "@/lib/content/types";

export function articleTone(status: string): "slate" | "green" | "amber" | "red" | "blue" {
  if (status === "approved" || status === "published") return "green";
  if (status === "publish_queued" || status === "publishing") return "blue";
  if (status === "publish_failed") return "red";
  if (status === "awaiting_approval") return "blue";
  if (status === "needs_revision" || status === "draft") return "amber";
  if (status === "failed" || status === "rejected") return "red";
  return "slate";
}

export function qaTone(status?: string): "slate" | "green" | "amber" | "red" | "blue" {
  if (status === "PASS") return "green";
  if (status === "NEEDS_REVISION" || status === "stale") return "amber";
  if (status === "BLOCKED") return "red";
  return "slate";
}

export const STATUS_GROUPS: Array<{ key: string; label: string; statuses: ArticleStatus[] }> = [
  { key: "drafts", label: "Drafts", statuses: ["researching", "brief_ready", "outline_ready", "drafting", "draft", "qa"] },
  { key: "awaiting", label: "Awaiting Approval", statuses: ["awaiting_approval"] },
  { key: "approved", label: "Approved", statuses: ["approved"] },
  { key: "revision", label: "Needs Revision", statuses: ["needs_revision"] },
  { key: "failed", label: "Failed", statuses: ["failed"] },
  { key: "rejected", label: "Rejected", statuses: ["rejected"] },
  { key: "publishing", label: "Publishing", statuses: ["publish_queued", "publishing"] },
  { key: "published", label: "Published", statuses: ["published"] },
  { key: "publish_failed", label: "Publish Failed", statuses: ["publish_failed"] },
  { key: "unpublished", label: "Unpublished", statuses: ["unpublished"] },
];

export function ArticleTable({ articles, showClient = true, showWebsite = true }: { articles: Article[]; showClient?: boolean; showWebsite?: boolean }) {
  if (articles.length === 0) {
    return <EmptyState title="No content yet" description="Generate content from an approved opportunity or 30/60/90 plan item in the website's Strategy tab." />;
  }
  const th = "px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500";
  const td = "px-4 py-3 text-sm text-slate-600 align-top";
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50"><tr>
            <th className={th}>Title</th>
            {showClient && <th className={th}>Client</th>}
            {showWebsite && <th className={th}>Website</th>}
            <th className={th}>Type</th><th className={th}>Lang</th><th className={th}>Status</th><th className={th}>QA</th><th className={th}>Updated</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {articles.map((a) => (
              <tr key={a.id} className="hover:bg-slate-50">
                <td className={td}>
                  <Link href={`/articles/${a.id}`} className="font-medium text-slate-900 hover:text-sky-600">{a.title || a.primary_keyword || "Untitled draft"}</Link>
                  {a.primary_keyword && <p className="text-xs text-slate-500">{a.primary_keyword}</p>}
                  {(a.flags?.length || a.high_risk) ? <p className="mt-1 text-[11px] text-amber-700">{[...(a.flags ?? [])].slice(0, 3).join(" · ")}</p> : null}
                </td>
                {showClient && <td className={td}>{a.expand?.client?.business_name ?? "—"}</td>}
                {showWebsite && <td className={td}>{a.expand?.website?.name ?? "—"}</td>}
                <td className={td}>{CONTENT_TYPE_LABELS[a.content_type] ?? a.content_type}</td>
                <td className={td}>{a.language}</td>
                <td className={td}><Badge tone={articleTone(a.status)}>{ARTICLE_STATUS_LABELS[a.status] ?? a.status}</Badge></td>
                <td className={td}>{a.qa_status && a.qa_status !== "pending" ? <Badge tone={qaTone(a.qa_status)}>{a.qa_status}</Badge> : "—"}</td>
                <td className={td}>{formatRelative(a.updated)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function StatusSummary({ articles, hrefFor }: { articles: Article[]; hrefFor: (group: string) => string }) {
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-6">
      {STATUS_GROUPS.map((g) => (
        <Link key={g.key} href={hrefFor(g.key)} className="rounded-xl border border-slate-200 bg-white p-3 hover:border-slate-300">
          <p className="text-xs text-slate-500">{g.label}</p>
          <p className="text-2xl font-semibold text-slate-900">{articles.filter((a) => g.statuses.includes(a.status)).length}</p>
        </Link>
      ))}
    </div>
  );
}
