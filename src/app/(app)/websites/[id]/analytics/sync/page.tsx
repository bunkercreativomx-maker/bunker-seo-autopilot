import { requireUser, isAdmin } from "@/lib/pocketbase/auth";
import { listSyncJobs, storageCounts } from "@/lib/pocketbase/analytics";
import { Badge, Card, CardBody, CardHeader, EmptyState } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { fmtInt } from "@/lib/analytics/format";

export const dynamic = "force-dynamic";

const tone = (s: string) => (s === "completed" ? "green" : s === "completed_with_warnings" ? "amber" : s === "failed" ? "red" : s === "running" ? "blue" : "slate") as "green" | "amber" | "red" | "blue" | "slate";

function duration(a?: string, b?: string): string {
  if (!a || !b) return "—";
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60000).toFixed(1)} min`;
}

export default async function SyncHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { pb, user } = await requireUser();
  const [jobs, counts] = await Promise.all([listSyncJobs(pb, `website = "${id}"`, 50), storageCounts(pb, id)]);
  return (
    <div className="space-y-4">
      {isAdmin(user.role) && (
        <Card>
          <CardHeader title="Storage diagnostics" subtitle="Rows are upserted with deterministic unique keys; re-syncing never duplicates." />
          <CardBody className="grid grid-cols-2 gap-3 text-sm md:grid-cols-6">
            {([["site/day", counts.site], ["page/day", counts.page], ["query/day", counts.query], ["query+page/day", counts.queryPage], ["query labels", counts.labels], ["opportunities", counts.opps]] as const).map(([k, v]) => (
              <div key={k}><p className="text-xs text-slate-500">{k}</p><p className="font-semibold">{fmtInt(v)}</p></div>
            ))}
          </CardBody>
        </Card>
      )}
      {jobs.length === 0 ? <EmptyState title="No syncs yet" /> : (
        <Card>
          <CardBody className="overflow-x-auto p-0">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr><th className="px-4 py-2">Job</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Period</th><th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">Rows received</th><th className="px-3 py-2 text-right">Rows stored</th><th className="px-3 py-2">Duration</th><th className="px-3 py-2">Details</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {jobs.map((j) => (
                  <tr key={j.id} className="align-top">
                    <td className="px-4 py-2 font-mono text-xs">{j.id}<div className="font-sans text-slate-500">{formatDateTime(j.created_at)}</div></td>
                    <td className="px-3 py-2 text-xs">{j.sync_type} · {j.range_label}</td>
                    <td className="px-3 py-2 text-xs">{j.start_date ? `${j.start_date} → ${j.end_date}` : "—"}</td>
                    <td className="px-3 py-2"><Badge tone={tone(j.status)}>{j.status}</Badge>{(j.status === "running" || j.status === "queued") && <div className="text-xs text-slate-500">{j.progress}% · {j.step}</div>}</td>
                    <td className="px-3 py-2 text-right">{fmtInt(j.rows_received)}</td>
                    <td className="px-3 py-2 text-right">{fmtInt(j.rows_stored)}</td>
                    <td className="px-3 py-2 text-xs">{duration(j.started_at, j.completed_at)}</td>
                    <td className="max-w-[320px] px-3 py-2 text-xs">
                      {j.error_code && <p className="text-rose-600">{j.error_code}: {j.error_message}</p>}
                      {(j.warnings ?? []).map((w) => <p key={w.code} className="text-amber-700">{w.message}</p>)}
                      <p className="text-slate-500">requests {j.api_requests} · pagination {j.pagination_completed ? "complete" : "incomplete"}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
