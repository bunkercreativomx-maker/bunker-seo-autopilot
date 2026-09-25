import Link from "next/link";
import { requireUser } from "@/lib/pocketbase/auth";
import { getPages } from "@/lib/pocketbase/analytics";
import { Button, Card, CardBody, EmptyState, Input } from "@/components/ui";
import { ChangeCell, Pager, RangeTabs, SourceNote } from "@/components/analytics/widgets";
import { fmtInt, fmtPct, fmtPos, shortUrl } from "@/lib/analytics/format";

export const dynamic = "force-dynamic";

export default async function PagesPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const range = sp.range || "28d";
  const page = Math.max(1, Number(sp.page) || 1);
  const { pb } = await requireUser();
  const data = await getPages(pb, id, { range, page, perPage: 50, search: sp.q || "", sort: sp.sort || "clicks" });
  const base = `/websites/${id}/analytics/pages`;
  if (!data?.connected) return <EmptyState title="Search Console not connected" action={<Link href={`/websites/${id}/search-console`}><Button>Connect</Button></Link>} />;
  if (!data.period) return <EmptyState title="No Search Console data yet" description="Google Search Console has not reported finalized pages data for this property. This is shown as zero, not as an error." />;
  const keep: Record<string, string> = Object.fromEntries(Object.entries({ range, q: sp.q, sort: sp.sort }).filter(([, v]) => v)) as Record<string, string>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangeTabs base={base} current={range} />
        <a href={`/api/analytics/${id}/export/pages?range=${range}`} className="text-xs text-sky-600">Export CSV</a>
      </div>
      <form className="flex flex-wrap items-end gap-2 text-xs" action={base}>
        <input type="hidden" name="range" value={range} />
        <Input name="q" placeholder="URL contains…" defaultValue={sp.q} className="w-64" />
        <select name="sort" defaultValue={sp.sort ?? "clicks"} className="rounded-lg border border-slate-300 px-2 py-2">
          <option value="clicks">Sort: clicks</option><option value="impressions">Sort: impressions</option><option value="ctr">Sort: CTR</option><option value="position">Sort: avg. position</option>
        </select>
        <Button type="submit" variant="secondary">Filter</Button>
      </form>
      <SourceNote dataThrough={data.dataThrough} period={data.period} />
      <Card>
        <CardBody className="overflow-x-auto p-0">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr><th className="px-4 py-2">Page</th><th className="px-3 py-2 text-right">Clicks</th><th className="px-3 py-2 text-right">Impressions</th><th className="px-3 py-2 text-right">CTR</th><th className="px-3 py-2 text-right">Avg. position</th><th className="px-3 py-2">Change (clicks)</th><th className="px-3 py-2">Mapped content</th><th className="px-3 py-2">Published article</th><th className="px-3 py-2">SEO strategy</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.length === 0 && <tr><td colSpan={9} className="px-4 py-6 text-center text-slate-500">No pages with Search Console data in this period.</td></tr>}
              {data.rows.map((r) => (
                <tr key={r.page}>
                  <td className="max-w-[280px] truncate px-4 py-2" title={r.page}>
                    <Link className="text-sky-700 hover:underline" href={`/websites/${id}/analytics/queries?range=${range}&page_url=${encodeURIComponent(r.page)}`}>{shortUrl(r.page)}</Link>
                  </td>
                  <td className="px-3 py-2 text-right">{fmtInt(r.clicks)}</td>
                  <td className="px-3 py-2 text-right">{fmtInt(r.impressions)}</td>
                  <td className="px-3 py-2 text-right">{fmtPct(r.ctr, 2)}</td>
                  <td className="px-3 py-2 text-right">{fmtPos(r.position)}</td>
                  <td className="px-3 py-2"><ChangeCell change={r.change.clicks} /></td>
                  <td className="px-3 py-2 text-xs">{r.mapping.website_page ? (r.mapping.website_page.title || r.mapping.website_page.path) : "—"}</td>
                  <td className="px-3 py-2 text-xs">{r.mapping.article ? <Link className="text-sky-700" href={`/articles/${r.mapping.article.id}`}>{r.mapping.article.title}</Link> : "—"}</td>
                  <td className="px-3 py-2 text-xs text-slate-600">{(r.mapping.strategy_keywords ?? []).slice(0, 3).join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager base={base} page={page} perPage={50} total={data.total ?? 0} params={keep} />
        </CardBody>
      </Card>
    </div>
  );
}
