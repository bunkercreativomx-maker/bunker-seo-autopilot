"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

// Three things a person needs per website. The detailed engineering views are
// still reachable under "More" (for diagnosing), but out of the way.
const TABS = [
  { href: "", label: "Overview" },
  { href: "/content", label: "Posts" },
  { href: "/publishing", label: "Connect website" },
] as const;

const MORE = [
  { href: "/strategy", label: "Keywords & plan" },
  { href: "/seo", label: "SEO audit" },
  { href: "/pages", label: "Pages" },
  { href: "/analytics", label: "Analytics" },
  { href: "/search-console", label: "Search Console" },
  { href: "/autopilot", label: "Autopilot log" },
] as const;

/** Tabs shown on the website detail pages. Active tab derives from the URL. */
export function WebsiteTabs({ websiteId }: { websiteId: string }) {
  const pathname = usePathname();
  const base = `/websites/${websiteId}`;
  const isActive = (href: string) => {
    const full = href === "" ? base : `${base}${href}`;
    return pathname === full || (href !== "" && pathname.startsWith(`${full}/`));
  };
  const moreActive = MORE.find((t) => isActive(t.href));

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-slate-200">
      {TABS.map((t) => (
        <Link
          key={t.label}
          href={t.href === "" ? base : `${base}${t.href}`}
          className={cn(
            "rounded-t-lg px-4 py-2 text-sm font-medium transition-colors",
            isActive(t.href) ? "border-b-2 border-slate-900 text-slate-900" : "text-slate-500 hover:text-slate-700"
          )}
        >
          {t.label}
        </Link>
      ))}
      <details className="relative ml-auto">
        <summary className={cn("cursor-pointer list-none rounded-lg px-3 py-2 text-sm", moreActive ? "font-medium text-slate-900" : "text-slate-400 hover:text-slate-600")}>
          {moreActive ? moreActive.label : "More"} ▾
        </summary>
        <div className="absolute right-0 z-20 mt-1 w-48 rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
          {MORE.map((t) => (
            <Link key={t.href} href={`${base}${t.href}`} className={cn("block rounded-lg px-3 py-2 text-sm hover:bg-slate-50", isActive(t.href) ? "font-medium text-slate-900" : "text-slate-600")}>
              {t.label}
            </Link>
          ))}
        </div>
      </details>
    </div>
  );
}
