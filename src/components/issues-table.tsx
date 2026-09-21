import Link from "next/link";
import type { SeoIssue, IssueSeverity } from "@/lib/types";

function sevTone(s: IssueSeverity): string {
  switch (s) {
    case "critical": return "bg-rose-50 text-rose-700 ring-rose-200";
    case "high": return "bg-amber-50 text-amber-700 ring-amber-200";
    case "medium": return "bg-yellow-50 text-yellow-700 ring-yellow-200";
    case "low": return "bg-slate-50 text-slate-600 ring-slate-200";
    case "opportunity": return "bg-sky-50 text-sky-700 ring-sky-200";
  }
}

export function IssuesTable({ issues, websiteId }: { issues: SeoIssue[]; websiteId: string }) {
  if (issues.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
            <th className="px-4 py-2 font-medium">Severity</th>
            <th className="px-4 py-2 font-medium">Issue</th>
            <th className="px-4 py-2 font-medium">Category</th>
            <th className="px-4 py-2 font-medium">Page</th>
            <th className="px-4 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((i) => {
            const pageUrl = extractUrl(i);
            return (
              <tr key={i.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2.5">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${sevTone(i.severity)}`}>
                    {i.severity}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <div className="font-medium text-slate-900">{i.title || i.issue_type}</div>
                  {i.recommended_action && (
                    <div className="mt-0.5 line-clamp-1 text-xs text-slate-500">{i.recommended_action}</div>
                  )}
                </td>
                <td className="px-4 py-2.5 text-slate-600">{i.category || "—"}</td>
                <td className="px-4 py-2.5">
                  {i.expand?.page ? (
                    <Link href={`/websites/${websiteId}/pages/${i.expand.page.id}`} className="block max-w-[220px] truncate text-sky-600 hover:text-sky-500">
                      {truncateUrl(i.expand.page.url)}
                    </Link>
                  ) : pageUrl ? (
                    <span className="block max-w-[220px] truncate text-slate-500">{pageUrl}</span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-slate-600">{i.status}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function extractUrl(i: SeoIssue): string | null {
  const e = i.evidence || {};
  const u = (e as Record<string, unknown>).url || (e as Record<string, unknown>).source_url || (e as Record<string, unknown>).destination_url;
  return typeof u === "string" ? u : null;
}

function truncateUrl(u: string): string {
  try {
    const url = new URL(u);
    return `${url.hostname}${url.pathname.length > 30 ? url.pathname.slice(0, 30) + "…" : url.pathname}`;
  } catch {
    return u;
  }
}