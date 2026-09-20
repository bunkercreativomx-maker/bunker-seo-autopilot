"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import type { CrawlStatus } from "@/lib/types";

interface JobState {
  id: string;
  status: CrawlStatus;
  pages_discovered: number;
  pages_crawled: number;
  pages_failed: number;
  errors_count: number;
  error_message?: string;
}

const STAGES: Array<{ key: string; label: string }> = [
  { key: "queued", label: "Queued" },
  { key: "running", label: "Crawling" },
  { key: "done", label: "Completed" },
];

export function CrawlProgress({ jobId }: { jobId: string }) {
  const [state, setState] = useState<JobState | null>(null);
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    let attempts = 0;
    const poll = async () => {
      if (!alive) return;
      attempts++;
      try {
        const r = await fetch(`/api/crawl/${jobId}`, { cache: "no-store" });
        if (r.ok) {
          const d = (await r.json()) as JobState;
          if (!alive) return;
          setState(d);
          const done = d.status === "completed" || d.status === "completed_with_errors" || d.status === "failed" || d.status === "cancelled";
          if (done || attempts > 240) {
            // finished or ~4 minutes elapsed -> refresh once to show final data
            router.refresh();
            return;
          }
        }
      } catch {}
      setTimeout(poll, 2000);
    };
    poll();
    return () => {
      alive = false;
    };
  }, [jobId, router]);

  if (!state) {
    return <div className="text-xs text-slate-500">Starting analysis…</div>;
  }

  const isRunning = state.status === "queued" || state.status === "running";
  const failed = state.status === "failed";

  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {isRunning && (
            <span className="h-3 w-3 animate-pulse rounded-full bg-sky-500" />
          )}
          {!isRunning && !failed && state.status === "completed" && (
            <span className="h-3 w-3 rounded-full bg-emerald-500" />
          )}
          {failed && <span className="h-3 w-3 rounded-full bg-rose-500" />}
          <div className="text-sm font-medium text-sky-900">
            {isRunning ? "Analyzing website…" : failed ? "Analysis failed" : "Analysis complete"}
          </div>
        </div>
      </div>

      {/* stage bar */}
      <div className="mt-3 flex items-center gap-1">
        {STAGES.map((s) => {
          const activeStage = s.key === "queued" ? state.status === "queued" || state.status === "running" : true;
          return (
            <div key={s.key} className="flex flex-1 items-center gap-1">
              <div
                className={cn(
                  "h-1.5 flex-1 rounded-full",
                  activeStage && s.key !== "done" && isRunning ? "bg-sky-400" : s.key === "done" && !isRunning && !failed ? "bg-emerald-400" : "bg-slate-200"
                )}
              />
              <span className="hidden text-[10px] text-sky-700 sm:inline">{s.label}</span>
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-sky-800">
        <span>Pages: {state.pages_crawled || 0}</span>
        <span>Failed: {state.pages_failed || 0}</span>
        <span>Errors: {state.errors_count || 0}</span>
        {state.error_message && !isRunning && (
          <span className="font-mono text-rose-600">{state.error_message}</span>
        )}
      </div>
    </div>
  );
}