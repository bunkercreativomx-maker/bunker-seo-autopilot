import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser, canWrite } from "@/lib/pocketbase/auth";
import { getOpportunity } from "@/lib/pocketbase/analytics";
import { Badge, Card, CardBody, CardHeader, Input } from "@/components/ui";
import { AnalyticsForm } from "@/components/analytics/analytics-form";
import { decideOpportunityAction } from "@/app/actions/analytics";
import { formatDateTime } from "@/lib/format";
import { fmtInt, fmtPct, fmtPos } from "@/lib/analytics/format";
import { OPPORTUNITY_LABELS } from "@/lib/analytics/types";

export const dynamic = "force-dynamic";

type PeriodMetrics = { start?: string; end?: string; clicks?: number; impressions?: number; ctr?: number; position?: number | null };

function PeriodBlock({ title, p }: { title: string; p: PeriodMetrics | null | undefined }) {
  if (!p) return null;
  return (
    <div className="rounded-lg border border-slate-200 p-3 text-sm">
      <p className="text-xs font-medium text-slate-500">{title}{p.start ? ` · ${p.start} → ${p.end}` : ""}</p>
      <p className="mt-1">{fmtInt(p.clicks)} clicks · {fmtInt(p.impressions)} impressions · CTR {fmtPct(p.ctr, 2)} · avg. position {fmtPos(p.position ?? null)}</p>
    </div>
  );
}

export default async function OpportunityPage({ params }: { params: Promise<{ id: string; oppId: string }> }) {
  const { id, oppId } = await params;
  const { pb, user } = await requireUser();
  const o = await getOpportunity(pb, oppId);
  if (!o || o.website !== id) notFound();
  const ev = o.evidence as Record<string, unknown>;
  const cur = (ev.current_period ?? o.current_period) as PeriodMetrics | null;
  const prev = (ev.previous_period ?? o.previous_period) as PeriodMetrics | null;
  const decided = o.status === "accepted" || o.status === "ignored";
  const evidenceRest = Object.fromEntries(Object.entries(ev).filter(([k]) => !["current_period", "previous_period"].includes(k)));
  return (
    <div className="space-y-5">
      <Link href={`/websites/${id}/analytics/opportunities`} className="text-xs text-sky-600">← Opportunities</Link>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-slate-900">{OPPORTUNITY_LABELS[o.type] ?? o.type}</h2>
        <Badge tone={o.priority === "high" ? "red" : o.priority === "medium" ? "amber" : "slate"}>{o.priority} priority</Badge>
        <Badge tone={o.status === "accepted" ? "green" : "blue"}>{o.status}</Badge>
      </div>
      <Card>
        <CardHeader title="Evidence" subtitle="Source: Google Search Console · finalized data" />
        <CardBody className="space-y-3">
          {o.query && <p className="text-sm">Query: <b>“{o.query}”</b>{o.query && <Link className="ml-2 text-xs text-sky-600" href={`/websites/${id}/analytics/queries/view?query=${encodeURIComponent(o.query)}`}>open query</Link>}</p>}
          {o.page && <p className="text-sm">Page: <a className="text-sky-700" href={o.page} target="_blank" rel="noreferrer">{o.page}</a></p>}
          <p className="text-sm text-slate-800">{o.reason}</p>
          <div className="grid gap-3 md:grid-cols-2">
            <PeriodBlock title="Current period" p={cur} />
            <PeriodBlock title="Previous period" p={prev} />
          </div>
          {Object.keys(evidenceRest).length > 0 && <pre className="max-h-64 overflow-auto rounded bg-slate-50 p-3 text-xs text-slate-600">{JSON.stringify(evidenceRest, null, 2)}</pre>}
          <p className="text-xs text-slate-500">First detected {formatDateTime(o.first_detected_at)} · last detected {formatDateTime(o.last_detected_at)} · detected {o.detection_count}×. Average position is a mean, not a fixed rank. Changes are relative to the previous period and may be seasonal.</p>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Recommended action" />
        <CardBody><p className="text-sm text-slate-800">{o.recommended_action}</p><p className="mt-2 text-xs text-slate-500">Nothing is changed automatically. Content edits, new articles and publishing stay manual.</p></CardBody>
      </Card>
      <Card>
        <CardHeader title="Decision" subtitle={decided ? `Decided ${formatDateTime(o.decided_at)}${o.expand?.decided_by ? ` by ${o.expand.decided_by.name || o.expand.decided_by.email}` : ""}` : "Human review required."} />
        <CardBody className="space-y-3">
          {o.decision_note && <p className="text-sm">Note: {o.decision_note}</p>}
          {o.content_opportunity && <p className="text-sm text-emerald-700">Phase 3 content opportunity proposed: <Link className="underline" href={`/websites/${id}/content`}>{o.content_opportunity}</Link></p>}
          {canWrite(user.role) ? (
            <div className="flex flex-wrap gap-4">
              {o.status !== "accepted" && (
                <AnalyticsForm action={decideOpportunityAction} hidden={{ websiteId: id, opportunityId: o.id, decision: "accept" }} submitLabel="Accept">
                  <Input name="note" placeholder="Note (optional)" className="w-72" />
                  {(o.type === "new_query" || o.type === "striking_distance" || o.type === "page_query_mismatch") && (
                    <label className="mt-2 flex items-center gap-1 text-xs text-slate-600"><input type="checkbox" name="createContentOpportunity" /> Also propose a Phase 3 content opportunity (no article is generated)</label>
                  )}
                </AnalyticsForm>
              )}
              {o.status !== "ignored" && (
                <AnalyticsForm action={decideOpportunityAction} hidden={{ websiteId: id, opportunityId: o.id, decision: "ignore" }} submitLabel="Ignore" variant="secondary">
                  <Input name="note" placeholder="Reason (optional)" className="w-72" />
                </AnalyticsForm>
              )}
              {o.status === "new" && <AnalyticsForm action={decideOpportunityAction} hidden={{ websiteId: id, opportunityId: o.id, decision: "review" }} submitLabel="Mark reviewed" variant="ghost" />}
              {decided && <AnalyticsForm action={decideOpportunityAction} hidden={{ websiteId: id, opportunityId: o.id, decision: "reopen" }} submitLabel="Reopen" variant="ghost" />}
            </div>
          ) : (
            <p className="text-xs text-slate-500">Read-only role.</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
