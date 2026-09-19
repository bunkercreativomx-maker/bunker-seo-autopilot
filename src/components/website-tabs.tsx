"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

const TABS = ["Overview", "SEO", "Content", "Publishing", "Analytics", "Integrations"] as const;
type Tab = (typeof TABS)[number];

export function WebsiteTabs({ overview }: { overview: React.ReactNode }) {
  const [active, setActive] = useState<Tab>("Overview");

  return (
    <div>
      <div className="flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setActive(t)}
            className={cn(
              "rounded-t-lg px-4 py-2 text-sm font-medium transition-colors",
              active === t ? "border-b-2 border-slate-900 text-slate-900" : "text-slate-500 hover:text-slate-700"
            )}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="py-5">
        {active === "Overview" ? (
          overview
        ) : (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h3 className="text-sm font-semibold text-slate-900">Coming in a later phase</h3>
            <p className="mt-1 max-w-sm text-sm text-slate-500">
              The {active} module will be available in a future phase of the platform.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
