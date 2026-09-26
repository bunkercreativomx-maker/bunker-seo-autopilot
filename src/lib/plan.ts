// Monthly packages (posts per month). Keep planDays in sync with
// autopilot-worker/src/decide.js — the worker uses the same spread.
export const PACKAGES = [7, 15, 30] as const;

export function planDays(postsPerMonth: number, daysInMonth: number): number[] {
  const n = Math.max(0, Math.min(Math.floor(postsPerMonth || 0), daysInMonth));
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(1 + Math.floor((i * daysInMonth) / n));
  return out;
}

export const TZ = "America/Ciudad_Juarez";

/** Local calendar date parts in a timezone. */
export function localParts(d: Date, timeZone = TZ) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t: string) => Number(parts.find((x) => x.type === t)?.value);
  return { year: g("year"), month: g("month"), day: g("day") };
}

export function daysIn(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function packageLabel(n: number) {
  return n ? `${n} posts / month` : "No package";
}
