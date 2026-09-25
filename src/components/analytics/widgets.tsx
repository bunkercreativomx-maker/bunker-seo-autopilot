import Link from "next/link";
import { Card, CardBody } from "@/components/ui";
import { fmtChange, fmtInt, fmtPct, fmtPos, toneClass } from "@/lib/analytics/format";
import { RANGE_OPTIONS, SOURCE_LABEL, type Change } from "@/lib/analytics/types";
import { cn } from "@/lib/utils";

export function SourceNote({ dataThrough, period, className }: { dataThrough?: string | null; period?: { start: string; end: string } | null; className?: string }) {
  return (
    <p className={cn("text-xs text-slate-500", className)}>
      Source: {SOURCE_LABEL} · finalized data{period ? ` · ${period.start} → ${period.end}` : ""}{dataThrough ? ` · Data through: ${dataThrough} (Search Console / PT)` : ""}
    </p>
  );
}

export function RangeTabs({ base, current, extra = {} }: { base: string; current: string; extra?: Record<string, string> }) {
  return (
    <div className="flex flex-wrap gap-1">
      {RANGE_OPTIONS.map((r) => {
        const qs = new URLSearchParams({ ...extra, range: r.value });
        return (
          <Link key={r.value} href={`${base}?${qs}`} className={cn("rounded-lg px-3 py-1.5 text-xs font-medium", current === r.value ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50")}>
            {r.label}
          </Link>
        );
      })}
    </div>
  );
}

export function MetricCard({ label, value, change, kind = "int" }: { label: string; value: string; change?: Change; kind?: "int" | "pct" | "pos" }) {
  const c = fmtChange(change, kind);
  return (
    <Card>
      <CardBody>
        <p className="text-xs font-medium text-slate-500">{label}</p>
        <p className="mt-1 text-2xl font-semibold text-slate-900">{value}</p>
        {change && <p className={cn("mt-1 text-xs", toneClass(c.tone))}>{c.text} vs previous period</p>}
      </CardBody>
    </Card>
  );
}

export function ChangeCell({ change, kind = "int" }: { change?: Change; kind?: "int" | "pct" | "pos" }) {
  const c = fmtChange(change, kind);
  return <span className={cn("text-xs", toneClass(c.tone))}>{c.text}</span>;
}

/**
 * Two separate small-multiple bar charts (clicks, impressions) so their very
 * different scales are never overlaid on one misleading axis.
 */
export function DailyChart({ daily }: { daily: Array<{ date: string; clicks: number; impressions: number }> }) {
  if (!daily.length) return null;
  const series = [
    { key: "clicks" as const, label: "Clicks per day", color: "fill-sky-500" },
    { key: "impressions" as const, label: "Impressions per day", color: "fill-violet-500" },
  ];
  const w = Math.max(daily.length * 8, 240);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {series.map((s) => {
        const max = Math.max(1, ...daily.map((d) => d[s.key]));
        const bw = w / daily.length;
        return (
          <div key={s.key}>
            <p className="mb-1 text-xs font-medium text-slate-600">{s.label} <span className="font-normal text-slate-400">(max {fmtInt(max)})</span></p>
            <svg viewBox={`0 0 ${w} 80`} className="h-24 w-full" preserveAspectRatio="none" role="img" aria-label={s.label}>
              {daily.map((d, i) => {
                const h = (d[s.key] / max) * 76;
                return <rect key={d.date} x={i * bw + 0.5} y={80 - h} width={Math.max(bw - 1, 1)} height={h} className={s.color}><title>{`${d.date}: ${fmtInt(d[s.key])}`}</title></rect>;
              })}
            </svg>
            <div className="flex justify-between text-[10px] text-slate-400"><span>{daily[0].date}</span><span>{daily[daily.length - 1].date}</span></div>
          </div>
        );
      })}
    </div>
  );
}

export function MetricsInline({ m }: { m: { clicks: number; impressions: number; ctr: number; position: number | null } }) {
  return <span className="text-xs text-slate-600">{fmtInt(m.clicks)} clicks · {fmtInt(m.impressions)} impressions · CTR {fmtPct(m.ctr)} · avg. position {fmtPos(m.position)}</span>;
}

export function Pager({ base, page, perPage, total, params }: { base: string; page: number; perPage: number; total: number; params: Record<string, string> }) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return null;
  const link = (p: number) => `${base}?${new URLSearchParams({ ...params, page: String(p) })}`;
  return (
    <div className="flex items-center justify-between px-4 py-3 text-xs text-slate-600">
      <span>Page {page} of {pages} · {fmtInt(total)} rows</span>
      <div className="flex gap-2">
        {page > 1 && <Link className="rounded bg-white px-2 py-1 ring-1 ring-slate-200" href={link(page - 1)}>Previous</Link>}
        {page < pages && <Link className="rounded bg-white px-2 py-1 ring-1 ring-slate-200" href={link(page + 1)}>Next</Link>}
      </div>
    </div>
  );
}
