import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/pocketbase/auth";
import { getRun, listActions, listDecisions, listEvents, listSignals, type AutopilotSignal } from "@/lib/pocketbase/autopilot";
import { Badge, Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { Evidence, Timeline, WhyPanel, costLabel, priorityTone, statusToneAP } from "@/components/autopilot/autopilot-view";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AutopilotRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const { pb } = await requireUser();
  const run = await getRun(pb, runId); // org-scoped by list/view rules
  if (!run) notFound();
  const [events, decisions, actions, signals] = await Promise.all([
    listEvents(pb, `run = "${run.id}"`, 300),
    listDecisions(pb, `run = "${run.id}"`, 200),
    listActions(pb, `run = "${run.id}"`, 100),
    listSignals(pb, `website = "${run.website}"`, 200),
  ]);
  const signalById = new Map<string, AutopilotSignal>(signals.map((s) => [s.id, s]));
  const decisionById = new Map(decisions.map((d) => [d.id, d]));
  const result = (run.result ?? {}) as Record<string, unknown>;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Autopilot run ${run.id}`}
        description={`${run.expand?.website?.name ?? run.website} · ${run.trigger}${run.dry_run ? " · DRY RUN (no jobs executed)" : ""}`}
        action={<Link className="text-sm text-sky-700 hover:underline" href={`/websites/${run.website}/autopilot`}>← Website Autopilot</Link>}
      />
      <div className="grid gap-4 md:grid-cols-4">
        <Card><CardBody><p className="text-xs text-slate-500">Status</p><div className="mt-1"><Badge tone={statusToneAP(run.status)}>{run.status}</Badge></div><p className="mt-1 text-xs text-slate-500">{run.current_step}</p></CardBody></Card>
        <Card><CardBody><p className="text-xs text-slate-500">Started / completed</p><p className="mt-1 text-xs">{formatDateTime(run.started_at || run.created_at)}<br />{run.completed_at ? formatDateTime(run.completed_at) : "—"}</p></CardBody></Card>
        <Card><CardBody><p className="text-xs text-slate-500">Signals / decisions / actions</p><p className="mt-1 text-lg font-semibold">{run.signal_count ?? 0} / {run.decision_count ?? 0} / {run.action_count ?? 0}</p></CardBody></Card>
        <Card><CardBody><p className="text-xs text-slate-500">AI cost</p><p className="mt-1 text-sm">{costLabel(run)}</p></CardBody></Card>
      </div>
      {run.error_code ? <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{run.error_code}: {run.error_message}</div> : null}
      {run.reason ? <p className="text-sm text-slate-600">Reason: {run.reason}</p> : null}

      <Card>
        <CardHeader title="Timeline" />
        <CardBody><Timeline events={events} /></CardBody>
      </Card>

      {run.dry_run && result.dry_run ? (
        <Card>
          <CardHeader title="Dry run result" subtitle={`Jobs created: ${String(result.jobs_created ?? 0)}`} />
          <CardBody><Evidence evidence={result.dry_run as Record<string, unknown>} /></CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Actions" />
        <CardBody className="space-y-3">
          {!actions.length ? <p className="text-sm text-slate-500">{run.dry_run ? "Dry runs never create actions." : "No actions."}</p> : actions.map((a) => (
            <div key={a.id} className="rounded-lg border border-slate-200 px-3 py-2">
              <p className="text-sm"><Badge tone={statusToneAP(a.status)}>{a.status}</Badge> <strong>{a.action_type}</strong> → {a.target_type} {a.target_id} {a.job_id ? <span className="text-xs text-slate-500">· {a.job_type} {a.job_id}</span> : null} <span className="font-mono text-[10px] text-slate-400">{a.idempotency_key}</span></p>
              <WhyPanel action={a} decision={decisionById.get(a.decision)} signal={signalById.get(decisionById.get(a.decision)?.signal ?? "")} run={run} />
            </div>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Decisions & evidence" />
        <CardBody className="space-y-3">
          {decisions.map((d) => (
            <div key={d.id} className="rounded-lg border border-slate-200 px-3 py-2">
              <p className="text-sm"><strong>{d.decision_type}</strong> <Badge tone={priorityTone(d.priority)}>{d.priority}</Badge> <span className="text-xs text-slate-500">score {d.score} · risk {d.risk_level} · rule {d.rule}</span>{d.block_code ? <> <Badge tone="amber">{d.block_code}</Badge></> : null}</p>
              <p className="text-xs text-slate-600">{d.reason}</p>
              <details className="mt-1 text-xs"><summary className="cursor-pointer text-slate-500">Evidence</summary><div className="mt-1"><Evidence evidence={d.evidence} /></div></details>
            </div>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}
