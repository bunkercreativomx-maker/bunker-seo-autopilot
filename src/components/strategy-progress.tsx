"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { StrategyJobStatus } from "@/lib/types";

interface StrategyJobState {
  id: string;
  status: StrategyJobStatus;
  stage: string;
  progress: number;
  message?: string;
  error_message?: string;
}

const TERMINAL = new Set<StrategyJobStatus>(["completed", "failed", "cancelled"]);

export function StrategyProgress({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<StrategyJobState | null>(null);
  const router = useRouter();

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    const poll = async () => {
      if (!active) return;
      attempts += 1;
      try {
        const response = await fetch(`/api/strategy/${jobId}`, { cache: "no-store" });
        if (response.ok) {
          const next = (await response.json()) as StrategyJobState;
          if (!active) return;
          setJob(next);
          if (TERMINAL.has(next.status) || attempts >= 300) {
            router.refresh();
            return;
          }
        }
      } catch {
        // A temporary network failure should not stop progress polling.
      }
      timer = setTimeout(poll, 2000);
    };

    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, router]);

  if (!job) return <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-800">Loading strategy job…</div>;

  const failed = job.status === "failed" || job.status === "cancelled";
  const progress = Math.min(100, Math.max(0, job.progress || 0));

  return (
    <div className={`rounded-xl border p-4 ${failed ? "border-rose-200 bg-rose-50" : "border-sky-200 bg-sky-50"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className={`text-sm font-semibold ${failed ? "text-rose-800" : "text-sky-900"}`}>
            {failed ? "Strategy generation stopped" : "Building SEO strategy"}
          </p>
          <p className={`text-xs ${failed ? "text-rose-600" : "text-sky-700"}`}>
            {(job.message || job.stage || job.status).replaceAll("_", " ")}
          </p>
        </div>
        <span className="text-sm font-semibold tabular-nums text-slate-700">{progress}%</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/80">
        <div className={`h-full rounded-full transition-all ${failed ? "bg-rose-500" : "bg-sky-500"}`} style={{ width: `${progress}%` }} />
      </div>
      {job.error_message && <p className="mt-2 text-xs text-rose-700">{job.error_message}</p>}
    </div>
  );
}
