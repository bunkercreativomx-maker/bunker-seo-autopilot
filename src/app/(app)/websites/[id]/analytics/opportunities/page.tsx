import Link from "next/link";
import { requireUser } from "@/lib/pocketbase/auth";
import { listOpportunities } from "@/lib/pocketbase/analytics";
import { Badge, Button, Card, CardBody, EmptyState } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { OPPORTUNITY_LABELS } from "@/lib/analytics/types";
import { shortUrl } from "@/lib/analytics/format";

export const dynamic = "force-dynamic";

const pTone = (p: string) => (p === "high" ? "red" : p === "medium" ? "amber" : "slate") as "red" | "amber" | "slate";
const sTone = (s: string) => (s === "accepted" ? "green" : s === "ignored" || s === "resolved" ? "slate" : "blue") as "green" | "slate" | "blue";

export default async function OpportunitiesPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { pb } = await requireUser();
  const status = sp.status || "open";
  const list = await listOpportunities(pb, id, { status, type: sp.type, priority: sp.priority, page: Number(sp.page) || 1 });
  const base = `/websites/${id}/analytics/opportunities`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <form className="flex flex-wrap items-end gap-2 text-xs" action={base}>
          <select name="status" defaultValue={status} className="rounded-lg border border-slate-300 px-2 py-2">
            <option value="open">Open (new + reviewed)</option><option value="accepted">Accepted</option><option value="ignored">Ignored</option><option value="resolved">Resolved</option><option value="all">All</option>
          </select>
          <select name="type" defaultValue={sp.type ?? ""} className="rounded-lg border border-slate-300 px-2 py-2">
            <option value="">All types</option>
            {Object.entries(OPPORTUNITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select name="priority" defaultValue={sp.priority ?? ""} className="rounded-lg border border-slate-300 px-2 py-2">
            <option value="">Any priority</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
          </select>
          <Button type="submit" variant="secondary">Filter</Button>
        </form>
        <a href={`/api/analytics/${id}/export/opportunities`} className="text-xs text-sky-600">Export CSV</a>
      </div>
      <p className="text-xs text-slate-500">Recommendations are derived from Google Search Console data (28 finalized days vs the previous 28 by default). They never change content automatically — accepting one requires a human decision.</p>
      {list.items.length === 0 ? (
        <EmptyState title="No opportunities" description="Nothing met the evidence thresholds for this filter. Low-volume data is intentionally suppressed." />
      ) : (
        <Card>
          <CardBody className="p-0">
            <ul className="divide-y divide-slate-100">
              {list.items.map((o) => (
                <li key={o.id} className="px-5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link className="text-sm font-medium text-sky-700 hover:underline" href={`${base}/${o.id}`}>{OPPORTUNITY_LABELS[o.type] ?? o.type}</Link>
                    <Badge tone={pTone(o.priority)}>{o.priority}</Badge>
                    <Badge tone={sTone(o.status)}>{o.status}</Badge>
                    <span className="text-xs text-slate-400">first {formatDate(o.first_detected_at)} · last {formatDate(o.last_detected_at)} · seen {o.detection_count}×</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-700">{o.query && <b>“{o.query}”</b>} {o.page && <span className="text-slate-500">{shortUrl(o.page)}</span>}</p>
                  <p className="mt-1 text-xs text-slate-600">{o.reason}</p>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
