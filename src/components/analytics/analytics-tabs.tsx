"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "", label: "Overview" },
  { href: "/queries", label: "Queries" },
  { href: "/pages", label: "Pages" },
  { href: "/opportunities", label: "Opportunities" },
  { href: "/published", label: "Published Content" },
  { href: "/sync", label: "Sync History" },
] as const;

export function AnalyticsTabs({ websiteId }: { websiteId: string }) {
  const pathname = usePathname();
  const base = `/websites/${websiteId}/analytics`;
  return (
    <div className="mb-5 flex flex-wrap gap-1">
      {TABS.map((t) => {
        const full = `${base}${t.href}`;
        const active = t.href === "" ? pathname === base : pathname === full || pathname.startsWith(`${full}/`);
        return (
          <Link key={t.label} href={full} className={cn("rounded-lg px-3 py-1.5 text-xs font-medium", active ? "bg-sky-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200")}>
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
