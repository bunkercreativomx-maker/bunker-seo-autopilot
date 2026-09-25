"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/pocketbase/auth";
import { OperationError, userOperation } from "@/lib/pocketbase/operations";

export type AutopilotActionState = { error?: string; success?: string; code?: string; preview?: Record<string, unknown>; runId?: string } | undefined;

// Every Autopilot action forwards the signed-in user's token to
// /api/bsa/autopilot/* in PocketBase, which derives organization/role from the
// database, re-validates website ownership and enforces admin-only changes.
// The dashboard never holds worker or superuser credentials.

function message(error: unknown): AutopilotActionState {
  if (error instanceof OperationError && error.status < 500) return { error: error.message, code: error.code };
  console.error("[autopilot] action failed", error instanceof OperationError ? error.code : "unknown");
  return { error: "The operation failed. Please try again." };
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

function refresh(websiteId?: string) {
  if (websiteId) {
    revalidatePath(`/websites/${websiteId}/autopilot`);
    revalidatePath(`/websites/${websiteId}`);
  }
  revalidatePath("/autopilot");
}

const NUMERIC = [
  "maxActionsPerDay", "maxContentJobsPerDay", "maxContentJobsPerWeek", "maxPublicationsPerWeek", "maxRevisionJobsPerArticle",
  "maxStrategyRefreshPerWeek", "maxCrawlsPerWeek", "maxAiCallsDaily", "maxAiTokensDaily", "maxAiBudgetDaily", "maxAiBudgetMonthly",
  "cooldownHours", "optimizationCooldownDays", "crawlMaxAgeDays", "strategyMaxAgeDays", "approvalReminderDays",
] as const;

function policyBody(f: FormData): Record<string, unknown> {
  const body: Record<string, unknown> = {
    websiteId: str(f, "websiteId"),
    mode: str(f, "mode") || "OFF",
    schedule: str(f, "schedule") || "weekly",
    enabled: f.get("enabled") === "on",
    publishAfterHumanApproval: f.get("publishAfterHumanApproval") === "on",
    pauseOnFactFailure: f.get("pauseOnFactFailure") === "on",
    pauseOnIntegrationError: f.get("pauseOnIntegrationError") === "on",
    allowedActions: f.getAll("allowedActions").map(String),
    allowedEnvironments: f.getAll("allowedEnvironments").map(String),
    timezone: str(f, "timezone") || undefined,
  };
  const v = str(f, "expectedVersion");
  if (v) body.expectedVersion = Number(v);
  for (const k of NUMERIC) {
    const raw = str(f, k);
    if (raw !== "") body[k] = Number(raw);
  }
  return body;
}

export async function previewPolicyAction(_p: AutopilotActionState, f: FormData): Promise<AutopilotActionState> {
  try {
    const { pb } = await requireUser();
    const r = await userOperation<{ consequences: Record<string, unknown> }>(pb, "autopilot/policy/preview", policyBody(f));
    return { success: "Preview below — nothing was saved.", preview: r.consequences };
  } catch (e) { return message(e); }
}

export async function savePolicyAction(_p: AutopilotActionState, f: FormData): Promise<AutopilotActionState> {
  const body = policyBody(f);
  try {
    const { pb } = await requireUser();
    const r = await userOperation<{ consequences: Record<string, unknown> }>(pb, "autopilot/policy/save", body);
    refresh(String(body.websiteId));
    return { success: "Autopilot policy saved.", preview: r.consequences };
  } catch (e) { return message(e); }
}

async function simple(path: string, f: FormData, ok: string, extra: Record<string, unknown> = {}): Promise<AutopilotActionState> {
  const websiteId = str(f, "websiteId");
  try {
    const { pb } = await requireUser();
    const r = await userOperation<{ run?: { id: string; status: string }; merged?: boolean; created?: boolean }>(pb, path, { websiteId, reason: str(f, "reason") || undefined, ...extra });
    refresh(websiteId);
    const note = r?.run ? (r.created === false ? ` (existing run ${r.run.id} — ${r.merged ? "trigger merged" : r.run.status})` : ` (run ${r.run.id})`) : "";
    return { success: ok + note, runId: r?.run?.id };
  } catch (e) { return message(e); }
}

export const pauseWebsiteAction = async (p: AutopilotActionState, f: FormData) => simple("autopilot/pause", f, "Autopilot paused for this website.");
export const resumeWebsiteAction = async (p: AutopilotActionState, f: FormData) => simple("autopilot/resume", f, "Autopilot resumed.");
export const disableAction = async (p: AutopilotActionState, f: FormData) => simple("autopilot/disable", f, "Autopilot disabled (OFF).");
export const runNowAction = async (p: AutopilotActionState, f: FormData) => simple("autopilot/run", f, "Run requested. The Autopilot worker picks it up within a minute; policy and budgets still apply.");
export const dryRunAction = async (p: AutopilotActionState, f: FormData) => simple("autopilot/dry-run", f, "Dry run requested. No jobs will be executed.");
export const orgPauseAction = async (p: AutopilotActionState, f: FormData) => simple("autopilot/org/pause", f, "All Autopilot paused for the organization.");
export const orgResumeAction = async (p: AutopilotActionState, f: FormData) => simple("autopilot/org/resume", f, "Organization Autopilot resumed.");

export async function signalAction(_p: AutopilotActionState, f: FormData): Promise<AutopilotActionState> {
  const websiteId = str(f, "websiteId");
  try {
    const { pb } = await requireUser();
    const operation = str(f, "operation");
    await userOperation(pb, "autopilot/signal", { signalId: str(f, "signalId"), operation, days: Number(str(f, "days") || 0) || undefined, reason: str(f, "reason") || undefined });
    refresh(websiteId);
    return { success: operation === "ignore" ? "Signal ignored permanently." : operation === "restore" ? "Signal restored." : "Signal snoozed." };
  } catch (e) { return message(e); }
}

export async function cancelPlannedAction(_p: AutopilotActionState, f: FormData): Promise<AutopilotActionState> {
  const websiteId = str(f, "websiteId");
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "autopilot/action/cancel", { actionId: str(f, "actionId"), reason: str(f, "reason") || undefined });
    refresh(websiteId);
    return { success: "Action cancelled. Autopilot will not recreate it automatically." };
  } catch (e) { return message(e); }
}

export async function resolveTaskAction(_p: AutopilotActionState, f: FormData): Promise<AutopilotActionState> {
  const websiteId = str(f, "websiteId");
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "autopilot/task", { taskId: str(f, "taskId"), operation: str(f, "operation") || "done" });
    refresh(websiteId);
    return { success: "Updated." };
  } catch (e) { return message(e); }
}

export async function resetCircuitAction(_p: AutopilotActionState, f: FormData): Promise<AutopilotActionState> {
  const websiteId = str(f, "websiteId");
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "autopilot/circuit/reset", { circuitId: str(f, "circuitId") });
    refresh(websiteId);
    return { success: "Circuit closed. Autopilot may retry this action type on the next run." };
  } catch (e) { return message(e); }
}
