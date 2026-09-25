// Search Console calendar helpers. Search Console reports days in Pacific
// Time; dates are kept verbatim as YYYY-MM-DD strings (source_date) and are
// NEVER shifted into the viewer's timezone.
export const SOURCE_TIMEZONE = "Google Search Console / PT";
const DAY = 86400000;
const RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDate(value) {
  if (!RE.test(String(value || ""))) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function addDays(date, n) {
  if (!isDate(date)) throw new Error(`invalid date ${date}`);
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

export function diffDays(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
}

/** Inclusive number of days in [start, end]. */
export function spanDays(start, end) {
  return diffDays(start, end) + 1;
}

/** Today's calendar date in Pacific Time (Search Console's reporting day). */
export function todayPT(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function* eachDay(start, end) {
  for (let d = start; d <= end; d = addDays(d, 1)) yield d;
}

/**
 * A window of `days` finalized days ending at `end`, and the equally long
 * period immediately before it.
 */
export function comparisonWindows(end, days) {
  const start = addDays(end, -(days - 1));
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -(days - 1));
  return { start, end, prevStart, prevEnd, days };
}

/** Search Console keeps about 16 months of data. */
export const MAX_HISTORY_DAYS = 486;
