import { Card, CardBody, CardHeader } from "@/components/ui";
import { fmtCtr, fmtInt, fmtPos } from "@/lib/analytics/format";
import type { ArticlePerformance } from "@/lib/analytics/types";

/** Article → Search Performance (read-only, since publication). */
export function ArticleSearchPerformance({ perf }: { perf: ArticlePerformance | null }) {
  if (!perf || !perf.publicUrl) return null;
  return (
    <Card className="mt-6">
      <CardHeader title="Search Performance" subtitle={`Source: Google Search Console${perf.dataThrough ? ` · data through ${perf.dataThrough}` : ""}`} />
      <CardBody className="space-y-3 text-sm">
        {perf.connected === false && <p className="text-slate-500">Search Console is not connected for this website.</p>}
        {perf.connected && !perf.hasData && <p className="text-slate-500">No Search Console performance data yet.{perf.daysLive !== null && perf.daysLive !== undefined ? ` Live for ${perf.daysLive} days.` : ""}</p>}
        {perf.hasData && perf.totals && (
          <>
            <p className="text-xs text-slate-500">Performance since publication ({perf.sincePublication?.start} → {perf.sincePublication?.end}, {perf.daysLive} days live).</p>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div><p className="text-xs text-slate-500">Clicks</p><p className="font-semibold">{fmtInt(perf.totals.clicks)}</p></div>
              <div><p className="text-xs text-slate-500">Impressions</p><p className="font-semibold">{fmtInt(perf.totals.impressions)}</p></div>
              <div><p className="text-xs text-slate-500">CTR</p><p className="font-semibold">{fmtCtr(perf.totals.ctr, perf.totals.impressions)}</p></div>
              <div><p className="text-xs text-slate-500">Average Position</p><p className="font-semibold">{fmtPos(perf.totals.position)}</p></div>
            </div>
            {(perf.topQueries ?? []).length > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium text-slate-500">Top queries</p>
                <ul className="space-y-1 text-xs">
                  {perf.topQueries!.map((q) => <li key={q.query}>“{q.query}” — {fmtInt(q.clicks)} clicks · {fmtInt(q.impressions)} impressions · avg. position {fmtPos(q.position)}</li>)}
                </ul>
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
