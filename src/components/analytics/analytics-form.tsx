"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { AnalyticsActionState } from "@/app/actions/analytics";
import { Button } from "@/components/ui";

type Action = (prev: AnalyticsActionState, formData: FormData) => Promise<AnalyticsActionState>;

export function AnalyticsForm({
  action, hidden, children, submitLabel, pendingLabel = "Working…", variant = "primary", className, inline = false,
}: {
  action: Action;
  hidden: Record<string, string | number>;
  children?: React.ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  className?: string;
  inline?: boolean;
}) {
  const [state, formAction, pending] = useActionState<AnalyticsActionState, FormData>(action, undefined);
  const router = useRouter();
  useEffect(() => {
    if (state?.success) router.refresh();
  }, [state, router]);
  return (
    <form action={formAction} className={className}>
      {Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={String(value)} />)}
      <div className={inline ? "flex flex-wrap items-end gap-2" : ""}>
        {children}
        <div className={inline ? "flex items-center gap-2" : "mt-3 flex flex-wrap items-center gap-3"}>
          <Button type="submit" variant={variant} disabled={pending}>{pending ? pendingLabel : submitLabel}</Button>
        </div>
      </div>
      {state?.error && <p className="mt-2 text-xs text-rose-600">{state.code ? `${state.code}: ` : ""}{state.error}</p>}
      {state?.success && <p className="mt-2 text-xs text-emerald-700">{state.success}</p>}
      {state?.jobId && <SyncProgress jobId={state.jobId} />}
    </form>
  );
}

type JobView = { status: string; step: string; progress: number; rows_received: number; rows_stored: number; start_date: string; end_date: string; error_message: string };

/** Polls /api/analytics/sync/[jobId] until the job finishes. */
export function SyncProgress({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<JobView | null>(null);
  const router = useRouter();
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await fetch(`/api/analytics/sync/${jobId}`, { cache: "no-store" });
        if (r.ok) {
          const j = (await r.json()) as JobView;
          if (!alive) return;
          setJob(j);
          if (["completed", "completed_with_warnings", "failed", "cancelled"].includes(j.status)) { router.refresh(); return; }
        }
      } catch {}
      if (alive) timer = setTimeout(tick, 2000);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [jobId, router]);
  if (!job) return <p className="mt-2 text-xs text-slate-500">Waiting for the analytics worker…</p>;
  const done = ["completed", "completed_with_warnings"].includes(job.status);
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
      <div className="flex items-center justify-between"><span className="font-medium">{job.status}</span><span>{job.progress ?? 0}%</span></div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-slate-200"><div className={`h-full ${job.status === "failed" ? "bg-rose-500" : done ? "bg-emerald-500" : "bg-sky-500"}`} style={{ width: `${job.progress ?? 0}%` }} /></div>
      <p className="mt-2">{job.step}</p>
      {job.start_date && <p className="text-slate-500">Range {job.start_date} → {job.end_date} · rows received {job.rows_received} · stored {job.rows_stored}</p>}
      {job.error_message && <p className="text-rose-600">{job.error_message}</p>}
    </div>
  );
}
