import type { Change } from "./types";

const int = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function fmtInt(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? "—" : int.format(n);
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  return n === null || n === undefined || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(digits)}%`;
}

/** CTR is only meaningful with impressions: 0 impressions → "—" (never "0%"). */
export function fmtCtr(ctr: number | null | undefined, impressions: number | null | undefined, digits = 2): string {
  return !impressions ? "—" : fmtPct(ctr, digits);
}

/** Average position is a mean — always shown with one decimal, never as a rank. */
export function fmtPos(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) || n === 0 ? "—" : n.toFixed(1);
}

/**
 * "+12 (+50.0%)". Percentage omitted when the previous value is 0.
 * For position, a negative change is an improvement (lower is better).
 */
export function fmtChange(c: Change | undefined, kind: "int" | "pct" | "pos" = "int"): { text: string; tone: "up" | "down" | "flat" } {
  if (!c || c.abs === null || c.abs === undefined) return { text: "—", tone: "flat" };
  const sign = c.abs > 0 ? "+" : c.abs < 0 ? "−" : "±";
  const mag = Math.abs(c.abs);
  const abs = kind === "pct" ? `${(mag * 100).toFixed(2)} pp` : kind === "pos" ? mag.toFixed(1) : int.format(mag);
  const pct = kind === "int" && c.pct !== null && c.pct !== undefined ? ` (${sign}${Math.abs(c.pct * 100).toFixed(1)}%)` : "";
  const better = kind === "pos" ? c.abs < 0 : c.abs > 0;
  const tone = c.abs === 0 ? "flat" : better ? "up" : "down";
  return { text: `${sign}${abs}${pct}`, tone };
}

export function toneClass(tone: "up" | "down" | "flat"): string {
  return tone === "up" ? "text-emerald-600" : tone === "down" ? "text-rose-600" : "text-slate-500";
}

export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

export function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  // Neutralize spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
