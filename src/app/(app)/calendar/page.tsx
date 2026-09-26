import Link from "next/link";
import { requireUser } from "@/lib/pocketbase/auth";
import { loadCalendar, type CalItem } from "@/lib/pocketbase/calendar";
import { localParts, TZ } from "@/lib/plan";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Calendar" };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// One stable color per website (dot), status shown by chip style.
const DOTS = ["bg-sky-500", "bg-emerald-500", "bg-violet-500", "bg-rose-500", "bg-amber-500", "bg-cyan-500", "bg-lime-500", "bg-fuchsia-500"];
const CHIP: Record<CalItem["kind"], string> = {
  published: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  ready: "bg-sky-50 text-sky-800 ring-sky-200",
  writing: "bg-slate-50 text-slate-700 ring-slate-200",
  attention: "bg-rose-50 text-rose-800 ring-rose-200",
  planned: "bg-white text-slate-500 ring-slate-300 ring-dashed border border-dashed border-slate-300",
};
const LABEL: Record<CalItem["kind"], string> = { published: "Published", ready: "Ready for review", writing: "Being written", attention: "Needs attention", planned: "Planned" };

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ m?: string; site?: string }> }) {
  const { pb } = await requireUser();
  const sp = await searchParams;
  const now = localParts(new Date(), TZ);
  const [y, m] = /^\d{4}-\d{2}$/.test(sp.m || "") ? sp.m!.split("-").map(Number) : [now.year, now.month];
  const site = /^[a-z0-9]{15}$/.test(sp.site || "") ? sp.site! : "";
  const cal = await loadCalendar(pb, y, m, site);

  const key = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, "0")}`;
  const prev = m === 1 ? key(y - 1, 12) : key(y, m - 1);
  const next = m === 12 ? key(y + 1, 1) : key(y, m + 1);
  const q = (month: string, s = site) => `/calendar?m=${month}${s ? `&site=${s}` : ""}`;
  const color = new Map(cal.websites.map((w, i) => [w.id, DOTS[i % DOTS.length]]));

  const firstDow = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Monday first
  const cells: (number | null)[] = [...Array(firstDow).fill(null), ...Array.from({ length: cal.dim }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const byDay = new Map<number, CalItem[]>();
  for (const it of cal.items) byDay.set(it.day, [...(byDay.get(it.day) || []), it]);

  const totals = {
    published: cal.items.filter((i) => i.kind === "published").length,
    ready: cal.items.filter((i) => i.kind === "ready").length,
    planned: cal.items.filter((i) => i.kind === "planned").length,
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{MONTHS[m - 1]} {y}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {totals.published} published · {totals.ready} waiting for review · {totals.planned} planned
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={q(prev)} className="rounded-lg px-3 py-1.5 text-sm text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">←</Link>
          <Link href={q(key(now.year, now.month))} className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">Today</Link>
          <Link href={q(next)} className="rounded-lg px-3 py-1.5 text-sm text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">→</Link>
        </div>
      </header>

      {/* Clients / packages */}
      <div className="flex flex-wrap gap-2">
        <Link href={q(key(y, m), "")} className={cn("rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset", !site ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50")}>All clients</Link>
        {cal.websites.map((w) => {
          const info = cal.sites.find((s) => s.id === w.id);
          return (
            <Link key={w.id} href={q(key(y, m), w.id)} className={cn("inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset", site === w.id ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50")}>
              <span className={cn("h-2 w-2 rounded-full", color.get(w.id))} />
              {w.name}
              {info?.postsPerMonth ? <span className={site === w.id ? "text-slate-300" : "text-slate-400"}>· {info.done}/{info.postsPerMonth}</span> : null}
            </Link>
          );
        })}
      </div>

      {/* Month grid */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
          {WEEK.map((d) => <div key={d} className="px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-500">{d}</div>)}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((d, i) => {
            const list = d ? byDay.get(d) || [] : [];
            return (
              <div key={i} className={cn("min-h-28 border-b border-r border-slate-100 p-1.5 [&:nth-child(7n)]:border-r-0", !d && "bg-slate-50/60")}>
                {d && (
                  <>
                    <div className={cn("mb-1 flex h-6 w-6 items-center justify-center rounded-full text-xs", d === cal.today ? "bg-sky-500 font-semibold text-white" : "text-slate-500")}>{d}</div>
                    <div className="space-y-1">
                      {list.slice(0, 4).map((it, j) => {
                        const inner = (
                          <span className={cn("flex items-center gap-1 truncate rounded-md px-1.5 py-1 text-[11px] leading-tight ring-1 ring-inset", CHIP[it.kind])} title={`${it.websiteName} — ${LABEL[it.kind]}: ${it.title}`}>
                            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", color.get(it.websiteId))} />
                            <span className="truncate">{it.kind === "planned" ? it.websiteName : it.title}</span>
                          </span>
                        );
                        return it.articleId ? <Link key={j} href={`/articles/${it.articleId}`} className="block hover:opacity-80">{inner}</Link> : <div key={j}>{inner}</div>;
                      })}
                      {list.length > 4 && <p className="px-1 text-[11px] text-slate-500">+{list.length - 4} more</p>}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 text-xs text-slate-500">
        {(["published", "ready", "writing", "attention", "planned"] as const).map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5"><span className={cn("h-3 w-5 rounded ring-1 ring-inset", CHIP[k])} />{LABEL[k]}</span>
        ))}
      </div>
      {cal.sites.every((s) => !s.postsPerMonth) && (
        <p className="rounded-xl bg-sky-50 px-4 py-3 text-sm text-sky-900">
          No packages yet. In <Link href="/today" className="font-semibold underline">Today</Link>, turn on posting for a client and pick 7, 15 or 30 posts per month — the planned days show up here.
        </p>
      )}
    </div>
  );
}
