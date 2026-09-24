"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { JOB_STEP_LABELS } from "@/lib/content/types";

const STEPS = ["queued", "building_context", "researching", "building_brief", "creating_outline", "writing_draft", "optimizing_seo", "checking_claims", "fact_checking", "quality_review", "revising", "awaiting_approval", "completed"];

type JobState = { status: string; step: string; progress: number; error?: string; error_code?: string };

/** Polls /api/content/[jobId] while a content job is active; refreshes the page when it ends. */
export function ContentJobProgress({ jobId, initial }: { jobId: string; initial: JobState }) {
  const [job, setJob] = useState<JobState>(initial);
  const router = useRouter();
  const active = job.status === "queued" || job.status === "running";

  useEffect(() => {
    if (!active) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/content/${jobId}`, { cache: "no-store" });
        if (res.ok) {
          const next = (await res.json()) as JobState;
          if (stop) return;
          setJob(next);
          if (next.status !== "queued" && next.status !== "running") router.refresh();
        }
      } catch {
        // transient network errors: keep polling
      }
    };
    const timer = setInterval(tick, 3000);
    return () => { stop = true; clearInterval(timer); };
  }, [active, jobId, router]);

  const currentIndex = Math.max(0, STEPS.indexOf(job.step));
  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50 p-4">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium text-sky-900">{active ? "Content job running" : job.status === "failed" ? "Content job failed" : "Content job finished"}: {JOB_STEP_LABELS[job.step] ?? job.step}</span>
        <span className="text-sky-800">{job.progress ?? 0}%</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-sky-100">
        <div className="h-full rounded-full bg-sky-600 transition-all" style={{ width: `${Math.min(100, job.progress ?? 0)}%` }} />
      </div>
      <ol className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
        {STEPS.map((step, index) => (
          <li key={step} className={`rounded-full px-2 py-0.5 ${index < currentIndex ? "bg-sky-200 text-sky-900" : index === currentIndex ? "bg-sky-700 text-white" : "bg-white text-slate-500 ring-1 ring-slate-200"}`}>{JOB_STEP_LABELS[step]}</li>
        ))}
      </ol>
      {job.error && <p className="mt-2 text-xs text-rose-700">{job.error_code ? `${job.error_code}: ` : ""}{job.error}</p>}
    </div>
  );
}
