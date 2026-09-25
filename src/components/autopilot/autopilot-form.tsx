"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { AutopilotActionState } from "@/app/actions/autopilot";
import { Button } from "@/components/ui";

type Action = (prev: AutopilotActionState, formData: FormData) => Promise<AutopilotActionState>;

function Preview({ data }: { data: Record<string, unknown> }) {
  const can = (data.can as string[]) ?? [];
  const cannot = (data.cannot as string[]) ?? [];
  return (
    <div className="mt-3 rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs text-slate-700">
      <p className="font-semibold text-slate-900">Mode: {String(data.mode)} {data.enabled ? "" : "(disabled)"} · Schedule: {String(data.schedule)}</p>
      <p className="mt-2 font-semibold">Can</p>
      <ul className="ml-4 list-disc">{can.map((c) => <li key={c}>{c}</li>)}</ul>
      <p className="mt-2 font-semibold">Cannot</p>
      <ul className="ml-4 list-disc">{cannot.map((c) => <li key={c}>{c}</li>)}</ul>
      <p className="mt-2"><span className="font-semibold">After human article approval, publish automatically:</span> {data.publish_after_human_approval ? "YES" : "NO"}</p>
      <p className="mt-1 text-slate-600">{String(data.publish_explanation ?? "")}</p>
    </div>
  );
}

/** Form bound to an Autopilot server action. Shows policy consequences when returned. */
export function AutopilotForm({
  action, hidden, children, submitLabel, pendingLabel = "Working…", variant = "primary", className, confirm,
}: {
  action: Action;
  hidden: Record<string, string | number>;
  children?: React.ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  className?: string;
  confirm?: string;
}) {
  const [state, formAction, pending] = useActionState<AutopilotActionState, FormData>(action, undefined);
  const router = useRouter();
  useEffect(() => {
    if (state?.success) router.refresh();
  }, [state, router]);
  return (
    <form
      action={formAction}
      className={className}
      onSubmit={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }}
    >
      {Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={String(value)} />)}
      {children}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button type="submit" variant={variant} disabled={pending}>{pending ? pendingLabel : submitLabel}</Button>
        {state?.error && <span className="text-xs text-rose-600">{state.code ? `${state.code}: ` : ""}{state.error}</span>}
        {state?.success && <span className="text-xs text-emerald-700">{state.success}</span>}
      </div>
      {state?.preview ? <Preview data={state.preview} /> : null}
    </form>
  );
}

/** Policy editor: the same fields submit either to Preview (nothing saved) or Save. */
export function PolicyEditor({ children, hidden, preview, save }: { children: React.ReactNode; hidden: Record<string, string | number>; preview: Action; save: Action }) {
  const [pState, pAction, pPending] = useActionState<AutopilotActionState, FormData>(preview, undefined);
  const [sState, sAction, sPending] = useActionState<AutopilotActionState, FormData>(save, undefined);
  const router = useRouter();
  useEffect(() => { if (sState?.success) router.refresh(); }, [sState, router]);
  const state = sState ?? pState;
  return (
    <form action={sAction}>
      {Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={String(value)} />)}
      {children}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="submit" formAction={pAction} variant="secondary" disabled={pPending || sPending}>{pPending ? "Previewing…" : "Preview consequences"}</Button>
        <Button type="submit" disabled={pPending || sPending}>{sPending ? "Saving…" : "Save policy"}</Button>
        {state?.error && <span className="text-xs text-rose-600">{state.code ? `${state.code}: ` : ""}{state.error}</span>}
        {state?.success && <span className="text-xs text-emerald-700">{state.success}</span>}
      </div>
      {pState?.preview ? <Preview data={pState.preview} /> : sState?.preview ? <Preview data={sState.preview} /> : null}
    </form>
  );
}
