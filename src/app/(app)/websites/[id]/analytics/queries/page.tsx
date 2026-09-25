import Link from "next/link";
import { requireUser } from "@/lib/pocketbase/auth";
import { getQueries } from "@/lib/pocketbase/analytics";
import { Badge, Button, Card, CardBody, EmptyState, Input } from "@/components/ui";
import { ChangeCell, Pager, RangeTabs, SourceNote } from "@/components/analytics/widgets";
import { fmtInt, fmtPct, fmtPos, shortUrl } from "@/lib/analytics/format";
import { ANONYMIZED_NOTE, MAPPING_LABELS } from "@/lib/analytics/types";

export const dynamic = "force-dynamic";

export default async function QueriesPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const range = sp.range || "28d";
  const page = Math.max(1, Number(sp.page) || 1);
  const { pb } = await requireUser();
  const filters = { search: sp.q || "", pageUrl: sp.page_url || "", intent: sp.intent || "", brand: sp.brand || "", mapping: sp.mapping || "", sort: sp.sort || "clicks" };
  const data = await getQueries(pb, id, { range, page, perPage: 50, ...filters });
  const base = `/websites/${id}/analytics/queries`;
  if (!data?.connected) return <EmptyState title="Search Console not connected" action={<Link href={`/websites/${id}/search-console`}><Button>Connect</Button></Link>} />;
  const keep: Record<string, string> = Object.fromEntries(Object.entries({ range, q: sp.q, page_url: sp.page_url, intent: sp.intent, brand: sp.brand, mapping: sp.mapping, sort: sp.sort }).filter(([, v]) => v)) as Record<string, string>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangeTabs base={base} current={range} extra={Object.fromEntries(Object.entries(keep).filter(([k]) => k !== "range"))} />
        <a href={`/api/analytics/${id}/export/queries?range=${range}`} className="text-xs text-sky-600">Export CSV</a>
      </div>
      <form className="flex flex-wrap items-end gap-2 text-xs" action={base}>
        <input type="hidden" name="range" value={range} />
        <Input name="q" placeholder="Query contains…" defaultValue={sp.q} className="w-48" />
        <Input name="page_url" placeholder="Landing page URL" defaultValue={sp.page_url} className="w-64" />
        <select name="intent" defaultValue={sp.intent ?? ""} className="rounded-lg border border-slate-300 px-2 py-2">
          <option value="">Any intent</option>
          {["informational", "commercial", "transactional", "navigational", "local", "mixed"].map((i) => <option key={i} value={i}>{i}</option>)}
        </select>
        <select name="brand" defaultValue={sp.brand ?? ""} className="rounded-lg border border-slate-300 px-2 py-2">
          <option value="">Brand + non-brand</option><option value="branded">Branded</option><option value="non_branded">Non-branded</option><option value="unknown">Unknown</option>
        </select>
        <select name="mapping" defaultValue={sp.mapping ?? ""} className="rounded-lg border border-slate-300 px-2 py-2">
          <option value="">Any Phase 3 mapping</option>
          {Object.entries(MAPPING_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select name="sort" defaultValue={sp.sort ?? "clicks"} className="rounded-lg border border-slate-300 px-2 py-2">
          <option value="clicks">Sort: clicks</option><option value="impressions">Sort: impressions</option><option value="ctr">Sort: CTR</option><option value="position">Sort: avg. position</option>
        </select>
        <Button type="submit" variant="secondary">Filter</Button>
      </form>
      <SourceNote dataThrough={data.dataThrough} period={data.period} />
      <p className="text-xs text-slate-500">{ANONYMIZED_NOTE} Showing queries returned by Search Console.</p>
      <Card>
        <CardBody className="overflow-x-auto p-0">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr><th className="px-4 py-2">Query</th><th className="px-3 py-2 text-right">Clicks</th><th className="px-3 py-2 text-right">Impressions</th><th className="px-3 py-2 text-right">CTR</th><th className="px-3 py-2 text-right">Avg. position</th><th className="px-3 py-2">Change (clicks)</th><th className="px-3 py-2">Landing page</th><th className="px-3 py-2">Labels</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.length === 0 && <tr><td colSpan={8} className="px-4 py-6 text-center text-slate-500">No queries returned by Search Console for this filter.</td></tr>}
              {data.rows.map((r) => (
                <tr key={r.query}>
                  <td className="px-4 py-2"><Link className="text-sky-700 hover:underline" href={`/websites/${id}/analytics/queries/view?query=${encodeURIComponent(r.query)}&range=${range}`}>{r.query}</Link></td>
                  <td className="px-3 py-2 text-right">{fmtInt(r.clicks)}</td>
                  <td className="px-3 py-2 text-right">{fmtInt(r.impressions)}</td>
                  <td className="px-3 py-2 text-right">{fmtPct(r.ctr, 2)}</td>
                  <td className="px-3 py-2 text-right">{fmtPos(r.position)}</td>
                  <td className="px-3 py-2"><ChangeCell change={r.change.clicks} /></td>
                  <td className="max-w-[220px] truncate px-3 py-2 text-xs text-slate-600" title={r.landing_page}>{r.landing_page ? shortUrl(r.landing_page) : "—"}</td>
                  <td className="space-x-1 px-3 py-2">
                    <Badge tone={r.mapping === "known_keyword" ? "green" : r.mapping === "new_query" ? "blue" : "slate"}>{MAPPING_LABELS[r.mapping] ?? r.mapping ?? "—"}</Badge>
                    {r.intent && <Badge>{r.intent}</Badge>}
                    {r.brand === "branded" && <Badge tone="amber">brand</Badge>}
                  </td>
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
