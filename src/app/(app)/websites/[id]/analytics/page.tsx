import Link from "next/link";
import { requireUser, isAdmin } from "@/lib/pocketbase/auth";
import { getSummary } from "@/lib/pocketbase/analytics";
import { Button, Card, CardBody, CardHeader, EmptyState, Input } from "@/components/ui";
import { DailyChart, MetricCard, RangeTabs, SourceNote } from "@/components/analytics/widgets";
import { AnalyticsForm } from "@/components/analytics/analytics-form";
import { qualityFlagAction } from "@/app/actions/analytics";
import { fmtCtr, fmtInt, fmtPos } from "@/lib/analytics/format";
import { ANONYMIZED_NOTE } from "@/lib/analytics/types";

export const dynamic = "force-dynamic";

export default async function AnalyticsOverview({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const range = sp.range || "28d";
  const { pb, user } = await requireUser();
  const s = await getSummary(pb, id, { range, startDate: sp.start, endDate: sp.end });
  const base = `/websites/${id}/analytics`;

  if (!s || !s.connected) {
    return (
      <EmptyState
        title="Search Console not connected"
        description="Connect Google Search Console and map a property to this website to see real clicks, impressions, CTR and average position."
        action={<Link href={`/websites/${id}/search-console`}><Button>Open Search Console integration</Button></Link>}
      />
    );
  }
  if (!s.period) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <MetricCard label="Clicks" value="0" />
          <MetricCard label="Impressions" value="0" />
          <MetricCard label="CTR" value="—" />
          <MetricCard label="Average Position" value="—" />
        </div>
        <EmptyState title="No Search Console data yet" description={`Google Search Console has returned no finalized data for ${s.property?.site_url ?? "this property"}. Shown as zero, not as an error.${s.property?.last_sync_at ? " Last sync: " + s.property.last_sync_at.slice(0, 16) + " UTC." : ""}`} action={<Link href={`/websites/${id}/analytics/sync`}><Button variant="secondary">Sync history</Button></Link>} />
        <SourceNote />
      </div>
    );
  }
  const t = s.totals!;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangeTabs base={base} current={range} />
        <form className="flex items-center gap-2 text-xs" action={base}>
          <input type="hidden" name="range" value="custom" />
          <Input type="date" name="start" defaultValue={sp.start} className="w-36" />
          <Input type="date" name="end" defaultValue={sp.end} className="w-36" />
          <Button type="submit" variant="secondary">Custom</Button>
        </form>
      </div>
      <SourceNote dataThrough={s.dataThrough} period={s.period} />
      {!s.hasData && <p className="rounded bg-slate-50 p-3 text-sm text-slate-600">No Search Console performance data in this period (0 impressions reported by Google).</p>}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Clicks" value={fmtInt(t.clicks)} change={s.comparison?.clicks} />
        <MetricCard label="Impressions" value={fmtInt(t.impressions)} change={s.comparison?.impressions} />
        <MetricCard label="CTR" value={fmtCtr(t.ctr, t.impressions)} change={s.comparison?.ctr} kind="pct" />
        <MetricCard label="Average Position" value={fmtPos(t.position)} change={s.comparison?.position} kind="pos" />
      </div>
      <p className="text-xs text-slate-500">
        Current {s.period.start} → {s.period.end} ({s.coverage?.currentDays ?? 0} days with data) vs previous {s.period.prevStart} → {s.period.prevEnd} ({s.coverage?.previousDays ?? 0} days with data).
        {s.previousTotals && ` Previous: ${fmtInt(s.previousTotals.clicks)} clicks · ${fmtInt(s.previousTotals.impressions)} impressions.`} Percent change is omitted when the previous value is 0. Lower average position is better.
      </p>

      <Card>
        <CardHeader title="Performance" subtitle="Clicks and impressions per day (separate scales)." />
        <CardBody><DailyChart daily={s.daily ?? []} /></CardBody>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Card><CardBody><p className="text-xs text-slate-500">Pages with impressions</p><p className="text-xl font-semibold">{fmtInt(s.counts?.pages)}</p><Link className="text-xs text-sky-600" href={`${base}/pages?range=${range}`}>View pages</Link></CardBody></Card>
        <Card><CardBody><p className="text-xs text-slate-500">Queries returned by Search Console</p><p className="text-xl font-semibold">{fmtInt(s.counts?.queries)}</p><Link className="text-xs text-sky-600" href={`${base}/queries?range=${range}`}>View queries</Link></CardBody></Card>
        <Card><CardBody><p className="text-xs text-slate-500">Open opportunities</p><p className="text-xl font-semibold">{fmtInt(s.openOpportunities)}</p><Link className="text-xs text-sky-600" href={`${base}/opportunities`}>Review</Link></CardBody></Card>
      </div>
      <p className="text-xs text-slate-500">
        {ANONYMIZED_NOTE} Query rows in this period sum to {fmtInt(s.counts?.query_clicks)} clicks / {fmtInt(s.counts?.query_impressions)} impressions vs site totals {fmtInt(t.clicks)} / {fmtInt(t.impressions)}.
      </p>

      <Card>
        <CardHeader title="Data quality flags" subtitle="Date ranges marked unreliable are excluded from opportunity detection." />
        <CardBody className="space-y-3">
          {(s.qualityFlags ?? []).length === 0 && <p className="text-xs text-slate-500">No flagged ranges.</p>}
          {(s.qualityFlags ?? []).map((f) => (
            <div key={f.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span>{f.start_date} → {f.end_date}: {f.reason}{f.exclude_from_opportunities ? " (excluded)" : ""}</span>
              {isAdmin(user.role) && <AnalyticsForm action={qualityFlagAction} hidden={{ websiteId: id, flagId: f.id }} submitLabel="Remove" variant="ghost" />}
            </div>
          ))}
          {isAdmin(user.role) && (
            <AnalyticsForm action={qualityFlagAction} hidden={{ websiteId: id }} submitLabel="Flag range as unreliable" variant="secondary" inline>
              <Input type="date" name="startDate" required className="w-36" />
              <Input type="date" name="endDate" required className="w-36" />
              <Input name="reason" required placeholder="Reason (e.g. Google reporting gap)" className="w-72" />
            </AnalyticsForm>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
