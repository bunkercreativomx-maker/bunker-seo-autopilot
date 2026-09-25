import "server-only";
import type PocketBase from "pocketbase";
import { userOperation } from "@/lib/pocketbase/operations";

// Autopilot reads. Records are scoped by PocketBase list rules to the signed-in
// user's organization; policy reads/changes go through /api/bsa/autopilot/*
// (server-side role + tenant validation). No superuser credentials here.

const q = (value: string) => `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export type Rec = Record<string, unknown> & { id: string };
export type AutopilotRun = Rec & {
  website: string; trigger: string; status: string; dry_run: boolean; mode: string; started_at: string; completed_at: string;
  current_step: string; signal_count: number; decision_count: number; action_count: number; ai_cost_status: string;
  actual_ai_cost: number | null; reason: string; error_code: string; error_message: string; result: Record<string, unknown> | null;
  created_at: string; parent_run: string; expand?: { website?: { name?: string } };
};
export type AutopilotAction = Rec & {
  run: string; decision: string; action_type: string; target_type: string; target_id: string; status: string; requires_approval: boolean;
  job_type: string; job_id: string; idempotency_key: string; attempt: number; max_attempts: number; started_at: string; completed_at: string;
  result: Record<string, unknown> | null; error_class: string; error_code: string; error_message: string; created_at: string; article: string;
  approved_by: string; approved_at: string; policy_snapshot: Record<string, unknown> | null;
};
export type AutopilotDecision = Rec & {
  run: string; signal: string; decision_type: string; priority: string; score: number; evidence: Record<string, unknown> | null; reason: string;
  rule: string; block_code: string; explanation: string; risk_level: string; requires_approval: boolean; status: string; created_at: string;
  policy_snapshot: Record<string, unknown> | null;
};
export type AutopilotSignal = Rec & {
  source: string; source_record: string; signal_type: string; evidence: Record<string, unknown> | null; strength: number; detected_at: string;
  last_seen_at: string; seen_count: number; expires_at: string; status: string; snoozed_until: string; status_reason: string; dedup_key: string;
};
export type AutopilotEvent = Rec & { run: string; action: string; kind: string; message: string; details: Record<string, unknown> | null; at: string };
export type AutopilotTask = Rec & {
  website: string; run: string; action: string; kind: string; title: string; body: string; link: string; status: string; created_at: string;
  evidence: Record<string, unknown> | null; expand?: { website?: { name?: string } };
};
export type AutopilotCircuit = Rec & { website: string; action_type: string; state: string; consecutive_failures: number; last_error_class: string; last_error_code: string; opened_at: string };
export type Heartbeat = Rec & { service: string; version: string; last_seen_at: string; details: Record<string, unknown> | null };

export type PolicyView = {
  id: string; exists: boolean; version: number; enabled: boolean; mode: "OFF" | "OBSERVE" | "SUPERVISED"; paused: boolean; schedule: string;
  allowed_actions: string[]; allowed_environments: string[]; next_run_at: string; last_run_at: string;
  max_actions_per_day: number; max_content_jobs_per_day: number; max_content_jobs_per_week: number; max_publications_per_week: number;
  max_revision_jobs_per_article: number; max_strategy_refresh_per_week: number; max_crawls_per_week: number;
  max_ai_budget_daily: number; max_ai_budget_monthly: number; max_ai_calls_daily: number; max_ai_tokens_daily: number;
  require_human_publish_approval: boolean; publish_after_human_approval: boolean; pause_on_high_risk: boolean; pause_on_fact_failure: boolean;
  pause_on_integration_error: boolean; cooldown_hours: number; optimization_cooldown_days: number; crawl_max_age_days: number;
  strategy_max_age_days: number; approval_reminder_days: number; timezone: string; full_auto_available: false;
};
export type Consequences = {
  mode: string; enabled: boolean; can: string[]; cannot: string[]; publish_after_human_approval: boolean; publish_explanation: string;
  publishing_environment: string; schedule: string;
  budgets: { ai_calls_daily: number; ai_tokens_daily: number; ai_budget_daily: number; ai_budget_monthly: number; note: string };
};
export type PolicyResponse = { policy: PolicyView; consequences: Consequences; organization_paused: boolean; can_edit: boolean };

async function listAll<T>(pb: PocketBase, col: string, filter: string, sort: string, limit: number, expand?: string): Promise<T[]> {
  try {
    const r = await pb.collection(col).getList<T>(1, limit, { filter, sort, expand, requestKey: null });
    return r.items;
  } catch { return []; }
}

async function countOf(pb: PocketBase, col: string, filter: string): Promise<number> {
  try { return (await pb.collection(col).getList(1, 1, { filter, requestKey: null })).totalItems; } catch { return 0; }
}

export async function getPolicy(pb: PocketBase, websiteId: string): Promise<PolicyResponse | null> {
  try { return await userOperation<PolicyResponse>(pb, "autopilot/policy", { websiteId }); } catch { return null; }
}

export const listRuns = (pb: PocketBase, filter: string, limit = 20) => listAll<AutopilotRun>(pb, "autopilot_runs", filter, "-created_at", limit, "website");
export const listActions = (pb: PocketBase, filter: string, limit = 50) => listAll<AutopilotAction>(pb, "autopilot_actions", filter, "-created_at", limit);
export const listDecisions = (pb: PocketBase, filter: string, limit = 50) => listAll<AutopilotDecision>(pb, "autopilot_decisions", filter, "-created_at", limit);
export const listSignals = (pb: PocketBase, filter: string, limit = 50) => listAll<AutopilotSignal>(pb, "autopilot_signals", filter, "-last_seen_at", limit);
export const listEvents = (pb: PocketBase, filter: string, limit = 200) => listAll<AutopilotEvent>(pb, "autopilot_run_events", filter, "at", limit);
export const listTasks = (pb: PocketBase, filter: string, limit = 50) => listAll<AutopilotTask>(pb, "autopilot_tasks", filter, "-created_at", limit, "website");
export const listCircuits = (pb: PocketBase, filter: string) => listAll<AutopilotCircuit>(pb, "autopilot_circuits", filter, "-updated_at", 50);
export async function listHeartbeats(pb: PocketBase): Promise<Array<Heartbeat & { age_seconds: number }>> {
  const rows = await listAll<Heartbeat>(pb, "service_heartbeats", "", "service", 20);
  const now = Date.now();
  return rows.map((h) => ({ ...h, age_seconds: (now - Date.parse(String(h.last_seen_at).replace(" ", "T"))) / 1000 }));
}
export const listPolicies = (pb: PocketBase) => listAll<Rec & { website: string; enabled: boolean; mode: string; paused: boolean; next_run_at: string; last_run_at: string; expand?: { website?: { name?: string } } }>(pb, "autopilot_policies", "", "website", 200, "website");

export async function getOrgControl(pb: PocketBase): Promise<{ paused: boolean; reason: string; paused_at: string } | null> {
  const r = await listAll<Rec & { paused: boolean; reason: string; paused_at: string }>(pb, "autopilot_controls", "", "", 1);
  return r[0] ?? null;
}

export async function getRun(pb: PocketBase, id: string): Promise<AutopilotRun | null> {
  try { return await pb.collection("autopilot_runs").getOne<AutopilotRun>(id, { expand: "website", requestKey: null }); } catch { return null; }
}

export async function overviewCounts(pb: PocketBase, since: string) {
  const [runsToday, completedToday, failedRuns, actionsCompleted, waiting, failedActions, openTasks] = await Promise.all([
    countOf(pb, "autopilot_runs", `created_at >= ${q(since)} && dry_run = false`),
    countOf(pb, "autopilot_runs", `created_at >= ${q(since)} && dry_run = false && (status = "completed" || status = "completed_with_warnings")`),
    countOf(pb, "autopilot_runs", `created_at >= ${q(since)} && status = "failed"`),
    countOf(pb, "autopilot_actions", `completed_at >= ${q(since)} && (status = "completed" || status = "completed_with_warnings")`),
    countOf(pb, "autopilot_actions", `status = "waiting_for_approval"`),
    countOf(pb, "autopilot_actions", `created_at >= ${q(since)} && status = "failed"`),
    countOf(pb, "autopilot_tasks", `status = "open"`),
  ]);
  return { runsToday, completedToday, failedRuns, actionsCompleted, waiting, failedActions, openTasks };
}

export async function aiUsageSince(pb: PocketBase, since: string, websiteId?: string) {
  const filter = `timestamp >= ${q(since)}${websiteId ? ` && website = ${q(websiteId)}` : ""}`;
  try {
    const rows = await pb.collection("ai_usage").getFullList<Rec & { input_tokens?: number; output_tokens?: number; estimated_cost?: number | null; cost_status?: string }>({ filter, fields: "id,input_tokens,output_tokens,estimated_cost,cost_status", requestKey: null, batch: 500 });
    // A 0 in estimated_cost with cost_status "pricing_not_configured" means UNKNOWN, never $0.
    let tokens = 0, known = 0, unknown = 0;
    for (const r of rows) {
      tokens += Number(r.input_tokens || 0) + Number(r.output_tokens || 0);
      if ((r.cost_status === "calculated" || (!r.cost_status && Number(r.estimated_cost) > 0)) && typeof r.estimated_cost === "number") known += r.estimated_cost; else unknown += 1;
    }
    return { calls: rows.length, tokens, knownCost: Math.round(known * 10000) / 10000, unknownCostCalls: unknown };
  } catch { return { calls: 0, tokens: 0, knownCost: 0, unknownCostCalls: 0 }; }
}

export { q as pbQuote };
