"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "", label: "Overview" },
  { href: "/seo", label: "SEO" },
  { href: "/strategy", label: "Strategy" },
  { href: "/content", label: "Content" },
  { href: "/pages", label: "Pages" },
] as const;

/** Tabs shown on the website detail pages. Active tab derives from the URL. */
export function WebsiteTabs({ websiteId }: { websiteId: string }) {
  const pathname = usePathname();
  const base = `/websites/${websiteId}`;

  return (
    <div className="flex flex-wrap gap-1 border-b border-slate-200">
      {TABS.map((t) => {
        const full = t.href === "" ? base : `${base}${t.href}`;
        const active = pathname === full || (t.href !== "" && pathname.startsWith(`${full}/`));
        return (
          <Link
            key={t.label}
            href={full}
            className={cn(
              "rounded-t-lg px-4 py-2 text-sm font-medium transition-colors",
              active ? "border-b-2 border-slate-900 text-slate-900" : "text-slate-500 hover:text-slate-700"
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}