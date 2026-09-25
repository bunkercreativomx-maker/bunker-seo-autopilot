import Link from "next/link";
import { Badge } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import type { AutopilotAction, AutopilotDecision, AutopilotEvent, AutopilotRun, AutopilotSignal } from "@/lib/pocketbase/autopilot";

type Tone = "slate" | "green" | "amber" | "red" | "blue";

export function statusToneAP(status: string): Tone {
  if (["completed", "active", "closed", "done"].includes(status)) return "green";
  if (["failed", "open", "cancelled"].includes(status)) return "red";
  if (["waiting_for_approval", "paused", "blocked", "completed_with_warnings", "half_open", "snoozed"].includes(status)) return "amber";
  if (["running", "queued", "executing", "evaluating", "collecting_signals", "planning", "monitoring"].includes(status)) return "blue";
  return "slate";
}

export function priorityTone(p: string): Tone {
  return p === "critical" ? "red" : p === "high" ? "amber" : p === "medium" ? "blue" : "slate";
}

export function ModeBadge({ mode, enabled, paused, orgPaused }: { mode: string; enabled: boolean; paused?: boolean; orgPaused?: boolean }) {
  if (orgPaused) return <Badge tone="red">PAUSED (organization)</Badge>;
  if (paused) return <Badge tone="amber">PAUSED</Badge>;
  if (!enabled || mode === "OFF") return <Badge tone="slate">OFF</Badge>;
  return <Badge tone={mode === "SUPERVISED" ? "green" : "blue"}>{mode}</Badge>;
}

function short(v: unknown, max = 160): string {
  if (v === null || v === undefined || v === "") return "—";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Evidence as key/value rows — exactly what the decision engine used. */
export function Evidence({ evidence }: { evidence: Record<string, unknown> | null | undefined }) {
  const entries = Object.entries(evidence ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (!entries.length) return <p className="text-xs text-slate-500">No evidence recorded.</p>;
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-medium text-slate-500">{k}</dt>
          <dd className="break-all text-slate-800">{short(v, 220)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "Why did Autopilot do this?" — trigger, signal, evidence, decision, policy rule, result. */
export function WhyPanel({ action, decision, signal, run }: { action?: AutopilotAction; decision?: AutopilotDecision; signal?: AutopilotSignal; run?: AutopilotRun }) {
  return (
    <details className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
      <summary className="cursor-pointer font-medium text-slate-700">Why did Autopilot do this?</summary>
      <div className="mt-2 space-y-2">
        <p><span className="font-semibold">Trigger:</span> {run ? `${run.trigger}${run.dry_run ? " (dry run)" : ""} · run ${run.id}` : "—"}</p>
        <p><span className="font-semibold">Signal:</span> {signal ? `${signal.signal_type} from ${signal.source}${signal.source_record ? ` (${signal.source_record})` : ""}` : "—"}</p>
        <div><p className="font-semibold">Evidence:</p><Evidence evidence={decision?.evidence ?? signal?.evidence} /></div>
        <p><span className="font-semibold">Decision:</span> {decision ? `${decision.decision_type} · priority ${decision.priority} · score ${decision.score}` : "—"}</p>
        <p><span className="font-semibold">Reason:</span> {decision?.reason || "—"}</p>
        {decision?.explanation ? <p className="text-slate-600"><span className="font-semibold">Plan (advisory):</span> {decision.explanation}</p> : null}
        <p><span className="font-semibold">Policy rule:</span> {decision?.rule || "—"}{decision?.block_code ? ` · blocked: ${decision.block_code}` : ""}</p>
        <p><span className="font-semibold">Policy version used:</span> {short((decision?.policy_snapshot as Record<string, unknown> | null)?.version ?? (action?.policy_snapshot as Record<string, unknown> | null)?.version)}</p>
        {action ? <p><span className="font-semibold">Result:</span> {action.status}{action.error_code ? ` · ${action.error_code}: ${action.error_message}` : ""}{action.job_id ? ` · ${action.job_type} ${action.job_id}` : ""} · attempts {action.attempt || 0}/{action.max_attempts || 1}</p> : null}
        {action?.result ? <div><p className="font-semibold">Result detail:</p><Evidence evidence={action.result} /></div> : null}
      </div>
    </details>
  );
}

export function Timeline({ events }: { events: AutopilotEvent[] }) {
  if (!events.length) return <p className="text-sm text-slate-500">No timeline entries yet.</p>;
  return (
    <ol className="space-y-1 text-sm">
      {events.map((e) => (
        <li key={e.id} className="flex gap-3">
          <span className="w-40 shrink-0 font-mono text-xs text-slate-500">{formatDateTime(e.at)}</span>
          <span className="text-slate-800">{e.message}</span>
        </li>
      ))}
    </ol>
  );
}

export function RunsTable({ runs, showWebsite = false }: { runs: AutopilotRun[]; showWebsite?: boolean }) {
  if (!runs.length) return <p className="text-sm text-slate-500">No runs yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="text-left text-xs uppercase text-slate-500">
          <tr>
            <th className="py-2 pr-3">Started</th>
            {showWebsite ? <th className="py-2 pr-3">Website</th> : null}
            <th className="py-2 pr-3">Trigger</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3">Step</th>
            <th className="py-2 pr-3">Signals / Decisions / Actions</th>
            <th className="py-2 pr-3">AI cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {runs.map((r) => (
            <tr key={r.id}>
              <td className="py-2 pr-3 whitespace-nowrap"><Link className="text-sky-700 hover:underline" href={`/autopilot/runs/${r.id}`}>{formatDateTime(r.started_at || r.created_at)}</Link></td>
              {showWebsite ? <td className="py-2 pr-3">{r.expand?.website?.name ?? r.website}</td> : null}
              <td className="py-2 pr-3">{r.trigger}{r.dry_run ? <span className="ml-1"><Badge tone="blue">dry run</Badge></span> : null}</td>
              <td className="py-2 pr-3"><Badge tone={statusToneAP(r.status)}>{r.status}</Badge></td>
              <td className="py-2 pr-3 text-xs text-slate-600">{r.current_step || "—"}{r.error_code ? ` · ${r.error_code}` : ""}</td>
              <td className="py-2 pr-3 text-xs">{r.signal_count ?? 0} / {r.decision_count ?? 0} / {r.action_count ?? 0}</td>
              <td className="py-2 pr-3 text-xs">{costLabel(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function costLabel(r: Pick<AutopilotRun, "ai_cost_status" | "actual_ai_cost">): string {
  if (r.ai_cost_status === "none") return "no AI used";
  if (r.ai_cost_status === "unknown") return "unknown (pricing not configured)";
  if (r.ai_cost_status === "known") return `$${Number(r.actual_ai_cost || 0).toFixed(4)}`;
  return "—";
}
