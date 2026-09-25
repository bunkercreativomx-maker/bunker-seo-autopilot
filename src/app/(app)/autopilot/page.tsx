import Link from "next/link";
import { requireUser, isAdmin } from "@/lib/pocketbase/auth";
import {
  aiUsageSince, getOrgControl, listDecisions, listHeartbeats, listPolicies, listRuns, listSignals, listTasks, overviewCounts,
} from "@/lib/pocketbase/autopilot";
import { Badge, Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { AutopilotForm } from "@/components/autopilot/autopilot-form";
import { ModeBadge, RunsTable, priorityTone } from "@/components/autopilot/autopilot-view";
import { orgPauseAction, orgResumeAction, resolveTaskAction } from "@/app/actions/autopilot";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

const SERVICES: Array<[string, string]> = [
  ["autopilot", "Autopilot Worker"], ["crawler", "Crawler"], ["strategy", "Strategy"], ["content", "Content"], ["publisher", "Publisher"], ["analytics", "Analytics"],
];

function dayStart() { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.toISOString().replace("T", " "); }
function monthStart() { const d = new Date(); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); return d.toISOString().replace("T", " "); }

export default async function AutopilotDashboardPage() {
  const { pb, user } = await requireUser();
  const admin = isAdmin(user.role);
  const [control, policies, counts, runs, tasks, signals, decisions, beats, usageToday, usageMonth] = await Promise.all([
    getOrgControl(pb), listPolicies(pb), overviewCounts(pb, dayStart()), listRuns(pb, "", 15), listTasks(pb, `status = "open"`, 50),
    listSignals(pb, `status = "active"`, 200), listDecisions(pb, "", 15), listHeartbeats(pb), aiUsageSince(pb, dayStart()), aiUsageSince(pb, monthStart()),
  ]);
  const orgPaused = Boolean(control?.paused);
  const active = policies.filter((p) => p.enabled && p.mode !== "OFF" && !p.paused);
  const paused = policies.filter((p) => p.paused);
  const signalTypes = new Map<string, number>();
  for (const s of signals) signalTypes.set(s.signal_type, (signalTypes.get(s.signal_type) ?? 0) + 1);

  return (
    <div className="space-y-6">
      <PageHeader title="Autopilot" description="Coordinates crawl → strategy → content → human approval → publishing → measurement. Operational metrics only — not SEO performance." />

      {orgPaused ? (
        <div className="rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          <strong>All Autopilot is paused for this organization</strong>{control?.reason ? ` — ${control.reason}` : ""}{control?.paused_at ? ` (since ${formatDateTime(control.paused_at)})` : ""}. No new runs or actions start; existing jobs were not destroyed.
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="Active websites" value={active.length} />
        <Stat label="Paused websites" value={paused.length} />
        <Stat label="Runs today" value={`${counts.runsToday} (${counts.completedToday} completed)`} />
        <Stat label="Actions completed today" value={counts.actionsCompleted} />
        <Stat label="Waiting for approval" value={counts.waiting} />
        <Stat label="Failures today" value={`${counts.failedRuns} runs · ${counts.failedActions} actions`} />
        <Stat label="AI usage today / month" value={`${usageToday.calls} / ${usageMonth.calls} calls`} sub={usageMonth.unknownCostCalls ? `cost unknown for ${usageMonth.unknownCostCalls} calls` : `$${usageMonth.knownCost} this month`} />
        <Stat label="Active signals" value={signals.length} />
      </div>

      {admin ? (
        <Card>
          <CardHeader title="Organization kill switch" subtitle="Stops new runs and actions for every website. Running external jobs finish safely; nothing is deleted." />
          <CardBody>
            {orgPaused
              ? <AutopilotForm action={orgResumeAction} hidden={{}} submitLabel="Resume All Autopilot" />
              : <AutopilotForm action={orgPauseAction} hidden={{}} submitLabel="Pause All Autopilot" variant="danger" confirm="Pause Autopilot for every website in this organization?" />}
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Needs your attention" subtitle="Approval inbox: article approvals, missing facts, slug conflicts, high-risk reviews, reconnects, pauses." />
        <CardBody className="space-y-2">
          {!tasks.length ? <p className="text-sm text-slate-500">Nothing needs your attention.</p> : tasks.map((t) => (
            <div key={t.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              <div>
                <p className="text-sm font-semibold"><Badge tone="amber">{t.kind}</Badge> {t.title} <span className="text-xs font-normal text-slate-500">· {t.expand?.website?.name ?? t.website} · {formatDateTime(t.created_at)}</span></p>
                <p className="text-xs text-slate-600">{t.body}</p>
                <div className="flex gap-3 text-xs">
                  {t.link ? <Link className="text-sky-700 hover:underline" href={t.link}>Open →</Link> : null}
                  <Link className="text-sky-700 hover:underline" href={`/websites/${t.website}/autopilot`}>Website Autopilot →</Link>
                </div>
              </div>
              {user.role !== "viewer" && user.role !== "client" ? <AutopilotForm action={resolveTaskAction} hidden={{ websiteId: t.website, taskId: t.id, operation: "dismiss" }} submitLabel="Dismiss" variant="ghost" /> : null}
            </div>
          ))}
        </CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Websites" />
          <CardBody>
            {!policies.length ? <p className="text-sm text-slate-500">No website has an Autopilot policy yet. Every website starts OFF.</p> : (
              <ul className="divide-y divide-slate-100 text-sm">
                {policies.map((p) => (
                  <li key={p.id} className="flex items-center justify-between py-2">
                    <Link className="text-sky-700 hover:underline" href={`/websites/${p.website}/autopilot`}>{p.expand?.website?.name ?? p.website}</Link>
                    <span className="flex items-center gap-2 text-xs text-slate-500">{p.last_run_at ? `last ${formatDateTime(p.last_run_at)}` : "never run"} <ModeBadge mode={p.mode} enabled={p.enabled} paused={p.paused} orgPaused={orgPaused} /></span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Health" subtitle="Autopilot does not queue work for a dependency that is down." />
          <CardBody>
            <ul className="divide-y divide-slate-100 text-sm">
              {SERVICES.map(([key, label]) => {
                const b = beats.find((h) => h.service === key);
                const ok = Boolean(b && b.age_seconds < 300);
                return (
                  <li key={key} className="flex items-center justify-between py-2">
                    <span>{label}</span>
                    <span className="flex items-center gap-2 text-xs text-slate-500">{b ? `${b.version || ""} · seen ${formatDateTime(b.last_seen_at)}` : "no heartbeat"} <Badge tone={ok ? "green" : b ? "amber" : "slate"}>{ok ? "healthy" : b ? "stale" : "unknown"}</Badge></span>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Signals" subtitle="Active, deduplicated signals across websites." />
        <CardBody className="flex flex-wrap gap-2">
          {!signalTypes.size ? <p className="text-sm text-slate-500">No active signals.</p> : [...signalTypes.entries()].map(([t, n]) => <Badge key={t} tone="blue">{t} · {n}</Badge>)}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Recent decisions" />
        <CardBody>
          <ul className="divide-y divide-slate-100 text-sm">
            {decisions.map((d) => (
              <li key={d.id} className="py-2">
                <span className="text-xs text-slate-500">{formatDateTime(d.created_at)}</span> <strong>{d.decision_type}</strong> <Badge tone={priorityTone(d.priority)}>{d.priority}</Badge>{d.block_code ? <> <Badge tone="amber">{d.block_code}</Badge></> : null}
                <p className="text-xs text-slate-600">{d.reason} <Link className="text-sky-700 hover:underline" href={`/autopilot/runs/${d.run}`}>run →</Link></p>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Recent runs" />
        <CardBody><RunsTable runs={runs} showWebsite /></CardBody>
      </Card>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <Card>
      <CardBody>
        <p className="text-xs text-slate-500">{label}</p>
        <p className="mt-1 text-lg font-semibold text-slate-900">{value}</p>
        {sub ? <p className="text-xs text-slate-500">{sub}</p> : null}
      </CardBody>
    </Card>
  );
}
