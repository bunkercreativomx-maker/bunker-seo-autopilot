import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser, isAdmin } from "@/lib/pocketbase/auth";
import { getWebsite } from "@/lib/pocketbase/websites";
import {
  aiUsageSince, getPolicy, listActions, listCircuits, listDecisions, listEvents, listRuns, listSignals, listTasks,
  type AutopilotDecision, type AutopilotSignal,
} from "@/lib/pocketbase/autopilot";
import { Badge, Card, CardBody, CardHeader, Field, Input, Select } from "@/components/ui";
import { AutopilotForm, PolicyEditor } from "@/components/autopilot/autopilot-form";
import { Evidence, ModeBadge, RunsTable, Timeline, WhyPanel, costLabel, priorityTone, statusToneAP } from "@/components/autopilot/autopilot-view";
import {
  cancelPlannedAction, disableAction, dryRunAction, pauseWebsiteAction, previewPolicyAction, resetCircuitAction, resolveTaskAction,
  resumeWebsiteAction, runNowAction, savePolicyAction, signalAction,
} from "@/app/actions/autopilot";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

const ACTIONS = ["CRAWL", "STRATEGY_REFRESH", "GENERATE_CONTENT", "RECHECK_CONTENT", "REQUEST_REVISION", "PUBLISH", "VERIFY_PUBLICATION", "UPDATE_PUBLICATION", "NOTIFY_HUMAN", "WAIT"];

const LIMITS: Array<[string, string, string]> = [
  ["maxActionsPerDay", "max_actions_per_day", "Actions / day"],
  ["maxContentJobsPerDay", "max_content_jobs_per_day", "New articles / day"],
  ["maxContentJobsPerWeek", "max_content_jobs_per_week", "New articles / week"],
  ["maxPublicationsPerWeek", "max_publications_per_week", "Publications / week"],
  ["maxRevisionJobsPerArticle", "max_revision_jobs_per_article", "Auto revisions / article (max 2)"],
  ["maxStrategyRefreshPerWeek", "max_strategy_refresh_per_week", "Strategy refresh / week"],
  ["maxCrawlsPerWeek", "max_crawls_per_week", "Crawls / week"],
  ["maxAiCallsDaily", "max_ai_calls_daily", "AI calls / day"],
  ["maxAiTokensDaily", "max_ai_tokens_daily", "AI tokens / day"],
  ["maxAiBudgetDaily", "max_ai_budget_daily", "AI budget / day (USD, when pricing known)"],
  ["maxAiBudgetMonthly", "max_ai_budget_monthly", "AI budget / month (USD, when pricing known)"],
  ["cooldownHours", "cooldown_hours", "Cooldown between runs (hours)"],
  ["optimizationCooldownDays", "optimization_cooldown_days", "Optimization cooldown (days)"],
  ["crawlMaxAgeDays", "crawl_max_age_days", "Crawl max age (days)"],
  ["strategyMaxAgeDays", "strategy_max_age_days", "Strategy max age (days)"],
  ["approvalReminderDays", "approval_reminder_days", "Approval reminder after (days)"],
];

function startOfDayIso() { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.toISOString().replace("T", " "); }
function startOfMonthIso() { const d = new Date(); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); return d.toISOString().replace("T", " "); }

export default async function WebsiteAutopilotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { pb, user } = await requireUser();
  const website = await getWebsite(pb, id);
  if (!website) notFound();
  const ap = await getPolicy(pb, website.id);
  if (!ap) notFound();
  const { policy, consequences } = ap;
  const admin = isAdmin(user.role) && ap.can_edit;
  const canWrite = user.role !== "viewer" && user.role !== "client";
  const w = `website = "${website.id}"`;

  const [runs, actions, decisions, signals, tasks, circuits, usageToday, usageMonth] = await Promise.all([
    listRuns(pb, w, 15),
    listActions(pb, w, 60),
    listDecisions(pb, w, 120),
    listSignals(pb, w, 80),
    listTasks(pb, `${w} && status = "open"`, 30),
    listCircuits(pb, w),
    aiUsageSince(pb, startOfDayIso(), website.id),
    aiUsageSince(pb, startOfMonthIso(), website.id),
  ]);
  const current = runs.find((r) => !r.dry_run && !["completed", "completed_with_warnings", "failed", "cancelled"].includes(r.status)) ?? runs.find((r) => !r.dry_run);
  const lastDry = runs.find((r) => r.dry_run && r.status === "completed");
  const events = current ? await listEvents(pb, `run = "${current.id}"`, 200) : [];
  const decisionById = new Map<string, AutopilotDecision>(decisions.map((d) => [d.id, d]));
  const signalById = new Map<string, AutopilotSignal>(signals.map((s) => [s.id, s]));
  const runById = new Map(runs.map((r) => [r.id, r]));
  const waiting = actions.filter((a) => a.status === "waiting_for_approval");
  const queue = actions.filter((a) => ["planned", "blocked", "queued", "running"].includes(a.status));
  const history = actions.filter((a) => !["planned", "blocked", "queued", "running", "waiting_for_approval"].includes(a.status)).slice(0, 25);
  const openCircuits = circuits.filter((c) => c.state === "open");
  const hidden = { websiteId: website.id };
  const dry = (lastDry?.result as Record<string, unknown> | null)?.dry_run as Record<string, unknown> | undefined;

  return (
    <div className="space-y-6">
      {/* Status */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card><CardBody><p className="text-xs text-slate-500">Status</p><div className="mt-1"><ModeBadge mode={policy.mode} enabled={policy.enabled} paused={policy.paused} orgPaused={ap.organization_paused} /></div>{ap.organization_paused ? <p className="mt-1 text-xs text-rose-600">Organization kill switch is active.</p> : null}</CardBody></Card>
        <Card><CardBody><p className="text-xs text-slate-500">Schedule</p><p className="mt-1 text-sm font-semibold">{policy.schedule}</p><p className="text-xs text-slate-500">Next: {policy.enabled && !policy.paused && policy.next_run_at ? formatDateTime(policy.next_run_at) : "—"}</p></CardBody></Card>
        <Card><CardBody><p className="text-xs text-slate-500">Waiting for approval</p><p className="mt-1 text-xl font-semibold">{waiting.length}</p></CardBody></Card>
        <Card><CardBody><p className="text-xs text-slate-500">AI usage (today / month)</p><p className="mt-1 text-sm font-semibold">{usageToday.calls} / {usageMonth.calls} calls</p><p className="text-xs text-slate-500">{usageMonth.unknownCostCalls ? `cost unknown for ${usageMonth.unknownCostCalls} calls (pricing not configured)` : `$${usageMonth.knownCost}`}</p></CardBody></Card>
      </div>

      {/* Controls */}
      <Card>
        <CardHeader title="Controls" subtitle="Manual run and dry run still respect the policy, budgets, circuit breakers and human approval." />
        <CardBody className="flex flex-wrap gap-4">
          {canWrite ? <AutopilotForm action={dryRunAction} hidden={hidden} submitLabel="Dry Run" variant="secondary" /> : null}
          {admin ? <AutopilotForm action={runNowAction} hidden={hidden} submitLabel="Run Autopilot Now" /> : null}
          {admin && !policy.paused ? <AutopilotForm action={pauseWebsiteAction} hidden={hidden} submitLabel="Pause Autopilot" variant="danger" confirm="Pause Autopilot for this website? New actions stop; safe running jobs may finish." /> : null}
          {admin && policy.paused ? <AutopilotForm action={resumeWebsiteAction} hidden={hidden} submitLabel="Resume Autopilot" /> : null}
          {admin && policy.enabled ? <AutopilotForm action={disableAction} hidden={hidden} submitLabel="Turn OFF" variant="ghost" /> : null}
          {!admin ? <p className="text-sm text-slate-500">Only organization admins can enable, run, pause or change Autopilot.</p> : null}
        </CardBody>
      </Card>

      {lastDry && dry ? (
        <Card>
          <CardHeader title="Last dry run" subtitle={`${formatDateTime(lastDry.completed_at)} · no jobs were executed`} />
          <CardBody className="space-y-1 text-sm">
            <p>Would refresh crawl: <strong>{dry.would_refresh_crawl ? "yes" : "no"}</strong></p>
            <p>Would refresh strategy: <strong>{dry.would_refresh_strategy ? "yes" : "no"}</strong></p>
            <p>Would generate content: <strong>{dry.would_generate_content ? "yes" : "no"}</strong></p>
            {((dry.content as Array<Record<string, unknown>>) ?? []).map((c, i) => (
              <p key={i} className="ml-4 text-xs text-slate-600">• {String(c.keyword)} — {String(c.reason)} ({String(c.priority)}, score {String(c.score)})</p>
            ))}
            <p>Would publish: <strong>{String(dry.would_publish)}</strong></p>
            <p>Analytics: <strong>{String(dry.analytics)}</strong></p>
            <p>Estimated AI usage: <strong>{JSON.stringify(dry.estimated_ai_usage ?? "unknown")}</strong></p>
            {((dry.blocked as Array<Record<string, unknown>>) ?? []).length ? <p className="text-xs text-amber-700">Blocked: {((dry.blocked as Array<Record<string, unknown>>) ?? []).map((b) => `${b.decision} (${b.code})`).join(", ")}</p> : null}
            <Link className="text-xs text-sky-700 hover:underline" href={`/autopilot/runs/${lastDry.id}`}>Full evidence →</Link>
          </CardBody>
        </Card>
      ) : null}

      {/* Waiting for approval / human tasks */}
      <Card>
        <CardHeader title="Needs your attention" subtitle="Autopilot stops here. Nothing below is approved automatically — approval never times out into approval." />
        <CardBody className="space-y-3">
          {!tasks.length && !waiting.length ? <p className="text-sm text-slate-500">Nothing waiting.</p> : null}
          {tasks.map((t) => (
            <div key={t.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              <div>
                <p className="text-sm font-semibold text-slate-900"><Badge tone="amber">{t.kind}</Badge> {t.title}</p>
                <p className="text-xs text-slate-600">{t.body}</p>
                {t.link ? <Link className="text-xs text-sky-700 hover:underline" href={t.link}>Open →</Link> : null}
              </div>
              {canWrite ? <AutopilotForm action={resolveTaskAction} hidden={{ ...hidden, taskId: t.id, operation: "dismiss" }} submitLabel="Dismiss" variant="ghost" /> : null}
            </div>
          ))}
          {waiting.map((a) => (
            <div key={a.id} className="rounded-lg border border-slate-200 px-3 py-2">
              <p className="text-sm"><Badge tone="amber">{a.action_type}</Badge> {a.target_type} {a.article ? <Link className="text-sky-700 hover:underline" href={`/articles/${a.article}`}>open article</Link> : a.target_id}</p>
              <WhyPanel action={a} decision={decisionById.get(a.decision)} signal={signalById.get(decisionById.get(a.decision)?.signal ?? "")} run={runById.get(a.run)} />
            </div>
          ))}
        </CardBody>
      </Card>

      {openCircuits.length ? (
        <Card>
          <CardHeader title="Circuit breakers open" subtitle="Repeated failures paused these action types. Other safe actions may continue." />
          <CardBody className="space-y-2">
            {openCircuits.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 text-sm">
                <span><Badge tone="red">{c.action_type}</Badge> {c.consecutive_failures} consecutive {c.last_error_class} failures ({c.last_error_code}) since {formatDateTime(c.opened_at)}</span>
                {admin ? <AutopilotForm action={resetCircuitAction} hidden={{ ...hidden, circuitId: c.id }} submitLabel="Close circuit" variant="secondary" /> : null}
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {/* Current run + timeline */}
      <Card>
        <CardHeader title="Current run" subtitle={current ? `${current.trigger} · ${current.status} · ${current.current_step || ""}` : "No runs yet"} action={current ? <Link className="text-sm text-sky-700 hover:underline" href={`/autopilot/runs/${current.id}`}>Details →</Link> : null} />
        <CardBody>
          {current ? <p className="mb-3 text-xs text-slate-500">AI cost: {costLabel(current)}{current.error_code ? ` · ${current.error_code}: ${current.error_message}` : ""}</p> : null}
          <Timeline events={events} />
        </CardBody>
      </Card>

      {/* Action queue */}
      <Card>
        <CardHeader title="Action queue" subtitle="Planned, blocked, queued and running actions." />
        <CardBody className="space-y-3">
          {!queue.length ? <p className="text-sm text-slate-500">Queue is empty.</p> : null}
          {queue.map((a) => (
            <div key={a.id} className="rounded-lg border border-slate-200 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm"><Badge tone={statusToneAP(a.status)}>{a.status}</Badge> <strong>{a.action_type}</strong> → {a.target_type} {a.target_id}{a.error_code ? <span className="text-xs text-amber-700"> · {a.error_code}</span> : null}</p>
                {canWrite && ["planned", "blocked", "waiting_for_approval"].includes(a.status) ? <AutopilotForm action={cancelPlannedAction} hidden={{ ...hidden, actionId: a.id }} submitLabel="Cancel" variant="ghost" /> : null}
              </div>
              <WhyPanel action={a} decision={decisionById.get(a.decision)} signal={signalById.get(decisionById.get(a.decision)?.signal ?? "")} run={runById.get(a.run)} />
            </div>
          ))}
        </CardBody>
      </Card>

      {/* Signals */}
      <Card>
        <CardHeader title="Signals" subtitle="Deduplicated. Search Console with zero rows is NO_DATA — never treated as poor performance." />
        <CardBody>
          {!signals.length ? <p className="text-sm text-slate-500">No signals yet. Run a Dry Run to evaluate.</p> : (
            <div className="space-y-2">
              {signals.map((s) => (
                <div key={s.id} className="rounded-lg border border-slate-200 px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm"><Badge tone={statusToneAP(s.status)}>{s.status}</Badge> <strong>{s.signal_type}</strong> <span className="text-xs text-slate-500">from {s.source} · seen {s.seen_count}× · last {formatDateTime(s.last_seen_at)}{s.snoozed_until ? ` · snoozed until ${formatDateTime(s.snoozed_until)}` : ""}</span></p>
                    {canWrite ? (
                      <div className="flex flex-wrap gap-2">
                        {s.status === "active" ? <>
                          <AutopilotForm action={signalAction} hidden={{ ...hidden, signalId: s.id, operation: "snooze", days: 30 }} submitLabel="Snooze 30d" variant="ghost" />
                          <AutopilotForm action={signalAction} hidden={{ ...hidden, signalId: s.id, operation: "snooze", days: 90 }} submitLabel="Snooze 90d" variant="ghost" />
                          <AutopilotForm action={signalAction} hidden={{ ...hidden, signalId: s.id, operation: "ignore" }} submitLabel="Ignore" variant="ghost" confirm="Ignore this signal permanently? Autopilot will not act on it again." />
                        </> : ["ignored", "snoozed"].includes(s.status) ? <AutopilotForm action={signalAction} hidden={{ ...hidden, signalId: s.id, operation: "restore" }} submitLabel="Restore" variant="ghost" /> : null}
                      </div>
                    ) : null}
                  </div>
                  <details className="mt-1 text-xs"><summary className="cursor-pointer text-slate-500">Evidence</summary><div className="mt-1"><Evidence evidence={s.evidence} /></div></details>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Recent decisions */}
      <Card>
        <CardHeader title="Recent decisions" subtitle="Deterministic engine: signals + strategy + policy + budgets + risk + existing work." />
        <CardBody>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs uppercase text-slate-500"><tr><th className="py-2 pr-3">When</th><th className="py-2 pr-3">Decision</th><th className="py-2 pr-3">Priority</th><th className="py-2 pr-3">Score</th><th className="py-2 pr-3">Rule</th><th className="py-2 pr-3">Reason</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {decisions.slice(0, 30).map((d) => (
                  <tr key={d.id}>
                    <td className="py-2 pr-3 whitespace-nowrap text-xs">{formatDateTime(d.created_at)}</td>
                    <td className="py-2 pr-3"><strong>{d.decision_type}</strong>{d.block_code ? <span className="ml-1"><Badge tone="amber">{d.block_code}</Badge></span> : null}</td>
                    <td className="py-2 pr-3"><Badge tone={priorityTone(d.priority)}>{d.priority}</Badge></td>
                    <td className="py-2 pr-3 text-xs">{d.score}</td>
                    <td className="py-2 pr-3 text-xs text-slate-600">{d.rule}</td>
                    <td className="py-2 pr-3 text-xs text-slate-600">{d.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      {/* History */}
      <Card>
        <CardHeader title="History" subtitle="Completed, failed, skipped and cancelled actions. Runs are kept for audit." />
        <CardBody className="space-y-3">
          {history.map((a) => (
            <div key={a.id} className="rounded-lg border border-slate-200 px-3 py-2">
              <p className="text-sm"><Badge tone={statusToneAP(a.status)}>{a.status}</Badge> <strong>{a.action_type}</strong> → {a.target_type} {a.target_id} <span className="text-xs text-slate-500">{formatDateTime(a.completed_at || a.created_at)}</span></p>
              <WhyPanel action={a} decision={decisionById.get(a.decision)} signal={signalById.get(decisionById.get(a.decision)?.signal ?? "")} run={runById.get(a.run)} />
            </div>
          ))}
          <RunsTable runs={runs} />
        </CardBody>
      </Card>

      {/* Policy */}
      <Card>
        <CardHeader title={`Policy (v${policy.version})`} subtitle="Default is OFF. SUPERVISED never turns on by itself. FULL_AUTO is not available in this release." />
        <CardBody>
          {!admin ? (
            <div className="space-y-1 text-sm text-slate-600">
              <p>Mode: <strong>{policy.mode}</strong> · Enabled: <strong>{policy.enabled ? "yes" : "no"}</strong> · Schedule: <strong>{policy.schedule}</strong></p>
              <p>Publish after human approval: <strong>{consequences.publish_after_human_approval ? "YES" : "NO"}</strong></p>
              <p className="text-xs">{consequences.publish_explanation}</p>
            </div>
          ) : (
            <PolicyEditor hidden={{ ...hidden, expectedVersion: policy.version }} preview={previewPolicyAction} save={savePolicyAction}>
              <div className="grid gap-3 md:grid-cols-3">
                <Field label="Mode">
                  <Select name="mode" defaultValue={policy.mode}>
                    <option value="OFF">OFF — does nothing</option>
                    <option value="OBSERVE">OBSERVE — signals + recommendations only</option>
                    <option value="SUPERVISED">SUPERVISED — runs non-public workflows, stops for humans</option>
                  </Select>
                </Field>
                <Field label="Schedule">
                  <Select name="schedule" defaultValue={policy.schedule}>
                    <option value="weekly">Weekly</option>
                    <option value="daily">Daily</option>
                    <option value="manual_only">Manual only</option>
                  </Select>
                </Field>
                <Field label="Timezone"><Input name="timezone" defaultValue={policy.timezone} /></Field>
              </div>
              <div className="mt-3 flex flex-wrap gap-5 text-sm text-slate-700">
                <label className="flex items-center gap-2"><input type="checkbox" name="enabled" defaultChecked={policy.enabled} />Autopilot enabled</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="publishAfterHumanApproval" defaultChecked={policy.publish_after_human_approval} />Publish automatically after a human approves an article</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="pauseOnFactFailure" defaultChecked={policy.pause_on_fact_failure} />Pause on fact-check failure</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="pauseOnIntegrationError" defaultChecked={policy.pause_on_integration_error} />Pause on integration error</label>
                <label className="flex items-center gap-2 text-slate-400"><input type="checkbox" checked disabled readOnly />Human publish approval required (always)</label>
                <label className="flex items-center gap-2 text-slate-400"><input type="checkbox" checked disabled readOnly />Stop on high-risk content (always)</label>
              </div>
              <p className="mt-2 text-xs text-slate-500">When “publish automatically” is on, a human approval of an article lets Autopilot publish exactly that approved version to the website&apos;s configured publishing target — only if its environment is allowed below. High-risk articles always wait for a manual Publish. Autopilot never creates approvals.</p>
              <div className="mt-3">
                <p className="text-xs font-medium text-slate-600">Allowed actions</p>
                <div className="mt-1 flex flex-wrap gap-4 text-sm">
                  {ACTIONS.map((a) => <label key={a} className="flex items-center gap-1"><input type="checkbox" name="allowedActions" value={a} defaultChecked={policy.allowed_actions.includes(a)} />{a}</label>)}
                </div>
              </div>
              <div className="mt-3">
                <p className="text-xs font-medium text-slate-600">Allowed publishing environments (current target: {consequences.publishing_environment})</p>
                <div className="mt-1 flex gap-4 text-sm">
                  {["staging", "production"].map((e) => <label key={e} className="flex items-center gap-1"><input type="checkbox" name="allowedEnvironments" value={e} defaultChecked={policy.allowed_environments.includes(e)} />{e}</label>)}
                </div>
              </div>
              <p className="mt-4 text-xs font-medium text-slate-600">Limits & budgets</p>
              <div className="mt-1 grid gap-3 md:grid-cols-4">
                {LIMITS.map(([name, key, label]) => (
                  <Field key={name} label={label}><Input name={name} type="number" step={key.startsWith("max_ai_budget") ? "0.01" : "1"} defaultValue={String((policy as unknown as Record<string, number>)[key] ?? "")} /></Field>
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-500">{consequences.budgets.note}</p>
            </PolicyEditor>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
