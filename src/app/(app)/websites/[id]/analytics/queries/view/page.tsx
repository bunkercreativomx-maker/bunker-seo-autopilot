import Link from "next/link";
import { requireUser, canWrite } from "@/lib/pocketbase/auth";
import { getQueryDetail } from "@/lib/pocketbase/analytics";
import { Badge, Card, CardBody, CardHeader, EmptyState, Select } from "@/components/ui";
import { DailyChart, MetricCard, RangeTabs, SourceNote } from "@/components/analytics/widgets";
import { AnalyticsForm } from "@/components/analytics/analytics-form";
import { brandOverrideAction } from "@/app/actions/analytics";
import { fmtInt, fmtPct, fmtPos } from "@/lib/analytics/format";
import { OPPORTUNITY_LABELS } from "@/lib/analytics/types";

export const dynamic = "force-dynamic";

export default async function QueryDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const query = sp.query || "";
  const range = sp.range || "28d";
  const { pb, user } = await requireUser();
  const d = query ? await getQueryDetail(pb, id, query, { range }) : null;
  if (!d || !d.connected || !d.period) return <EmptyState title="Query not found" description="No Search Console data for this query in the selected period." />;
  if (!d.totals) return <EmptyState title={`“${query}”`} description="Search Console returned no rows for this query in the selected period." />;
  return (
    <div className="space-y-5">
      <div>
        <Link href={`/websites/${id}/analytics/queries?range=${range}`} className="text-xs text-sky-600">← Queries</Link>
        <h2 className="mt-1 text-lg font-semibold text-slate-900">“{d.query}”</h2>
        <SourceNote dataThrough={d.dataThrough} period={d.period} />
      </div>
      <RangeTabs base={`/websites/${id}/analytics/queries/view`} current={range} extra={{ query }} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Clicks" value={fmtInt(d.totals.clicks)} change={d.change?.clicks} />
        <MetricCard label="Impressions" value={fmtInt(d.totals.impressions)} change={d.change?.impressions} />
        <MetricCard label="CTR" value={fmtPct(d.totals.ctr, 2)} change={d.change?.ctr} kind="pct" />
        <MetricCard label="Average Position" value={fmtPos(d.totals.position)} change={d.change?.position} kind="pos" />
      </div>
      <Card><CardHeader title="Daily" /><CardBody><DailyChart daily={d.daily ?? []} /></CardBody></Card>
      <Card>
        <CardHeader title="Landing pages" subtitle="Pages Google showed for this query (query + page rows)." />
        <CardBody className="p-0">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr><th className="px-4 py-2">Page</th><th className="px-3 py-2 text-right">Clicks</th><th className="px-3 py-2 text-right">Impressions</th><th className="px-3 py-2 text-right">CTR</th><th className="px-3 py-2 text-right">Avg. position</th><th className="px-3 py-2">Mapped content</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {(d.landingPages ?? []).map((r) => (
                <tr key={r.page}>
                  <td className="px-4 py-2 text-xs"><a className="text-sky-700" href={r.page} target="_blank" rel="noreferrer">{r.page}</a></td>
                  <td className="px-3 py-2 text-right">{fmtInt(r.clicks)}</td>
                  <td className="px-3 py-2 text-right">{fmtInt(r.impressions)}</td>
                  <td className="px-3 py-2 text-right">{fmtPct(r.ctr, 2)}</td>
                  <td className="px-3 py-2 text-right">{fmtPos(r.position)}</td>
                  <td className="px-3 py-2 text-xs">
                    {r.mapping.article && <Link className="text-sky-700" href={`/articles/${r.mapping.article.id}`}>Article: {r.mapping.article.title}</Link>}
                    {!r.mapping.article && r.mapping.website_page && <span>Page: {r.mapping.website_page.title || r.mapping.website_page.path}</span>}
                    {(r.mapping.strategy_keywords ?? []).length > 0 && <div className="text-slate-500">Strategy: {r.mapping.strategy_keywords!.join(", ")}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(d.landingPages ?? []).length > 1 && <p className="px-4 py-2 text-xs text-slate-500">Several pages receive impressions for this query. This is evidence to review, not proof of cannibalization.</p>}
        </CardBody>
      </Card>
      {(d.opportunities ?? []).length > 0 && (
        <Card>
          <CardHeader title="Related opportunities" />
          <CardBody className="space-y-1">
            {d.opportunities!.map((o) => (
              <div key={o.id}><Link className="text-sm text-sky-700" href={`/websites/${id}/analytics/opportunities/${o.id}`}>{OPPORTUNITY_LABELS[o.type] ?? o.type}</Link> <Badge>{o.status}</Badge> <Badge>{o.priority}</Badge></div>
            ))}
          </CardBody>
        </Card>
      )}
      {canWrite(user.role) && (
        <Card>
          <CardHeader title="Brand classification override" subtitle="Manual override of the internal branded / non-branded label." />
          <CardBody>
            <AnalyticsForm action={brandOverrideAction} hidden={{ websiteId: id, normalizedQuery: query.toLowerCase() }} submitLabel="Save" variant="secondary" inline>
              <Select name="brand" defaultValue="" className="w-48">
                <option value="">Automatic</option><option value="branded">Branded</option><option value="non_branded">Non-branded</option>
              </Select>
            </AnalyticsForm>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
