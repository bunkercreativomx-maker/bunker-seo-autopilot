import Link from "next/link";
import { Badge } from "@/components/ui";
import type { WebsitePage } from "@/lib/types";

function statusTone(status?: number): string {
  if (!status) return "bg-slate-100 text-slate-600";
  if (status >= 500) return "bg-rose-50 text-rose-700";
  if (status === 404 || status >= 400) return "bg-amber-50 text-amber-700";
  if (status >= 300) return "bg-sky-50 text-sky-700";
  return "bg-emerald-50 text-emerald-700";
}

export function PagesTable({ pages, issuesByPage, websiteId }: { pages: WebsitePage[]; issuesByPage: Map<string, number>; websiteId: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
            <th className="px-4 py-2 font-medium">URL</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Title</th>
            <th className="px-4 py-2 font-medium">Indexable</th>
            <th className="px-4 py-2 font-medium">Words</th>
            <th className="px-4 py-2 font-medium">H1</th>
            <th className="px-4 py-2 font-medium">Internal</th>
            <th className="px-4 py-2 font-medium">Issues</th>
          </tr>
        </thead>
        <tbody>
          {pages.map((p) => (
            <tr key={p.id} className="border-b border-slate-100 hover:bg-slate-50">
              <td className="px-4 py-2.5">
                <Link href={`/websites/${websiteId}/pages/${p.id}`} className="block max-w-[240px] truncate text-sky-600 hover:text-sky-500">
                  {prettyUrl(p.url)}
                </Link>
              </td>
              <td className="px-4 py-2.5">
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusTone(p.status_code)}`}>
                  {p.status_code ?? "—"}
                </span>
              </td>
              <td className="max-w-[220px] truncate px-4 py-2.5 text-slate-800">{p.title || "—"}</td>
              <td className="px-4 py-2.5">
                {p.indexable === undefined ? "—" : p.indexable ? <span className="text-emerald-600">Yes</span> : <span className="text-rose-600">No</span>}
              </td>
              <td className="px-4 py-2.5 text-slate-600">{p.word_count ?? "—"}</td>
              <td className="px-4 py-2.5 text-slate-600">{p.h1_count ?? "—"}</td>
              <td className="px-4 py-2.5 text-slate-600">{p.internal_links_count ?? "—"}</td>
              <td className="px-4 py-2.5">
                {(issuesByPage.get(p.id) ?? 0) > 0 ? (
                  <Badge tone={issuesByPage.get(p.id)! >= 3 ? "red" : "amber"}>{issuesByPage.get(p.id)}</Badge>
                ) : (
                  <span className="text-slate-400">0</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function prettyUrl(u: string): string {
  try {
    const url = new URL(u);
    const p = url.pathname === "/" ? "" : url.pathname;
    return p ? `${url.hostname}${p.length > 40 ? p.slice(0, 40) + "…" : p}` : url.hostname;
  } catch {
    return u;
  }
}