import test from "node:test";
import assert from "node:assert/strict";
import { aggregate, change, compareTotals, ctr, detectOpportunities, reconcile, dedupeKey, normalizeQuery, ctrBaselines } from "../src/analytics.js";
import { comparisonWindows, addDays, spanDays, isDate } from "../src/dates.js";

const period = comparisonWindows("2026-09-20", 28);
const Q = (query, clicks, impressions, position, days = 28) => ({ query, clicks, impressions, ctr: ctr(clicks, impressions), position, days });
const P = (page, clicks, impressions, position, days = 28) => ({ page, clicks, impressions, ctr: ctr(clicks, impressions), position, days });
const cov = { currentDays: 28, previousDays: 28 };
const run = (current, previous, labels = new Map(), settings = {}, coverage = cov) => detectOpportunities({ period, current: { queryPages: [], ...current }, previous, coverage, labels, settings });
const types = (list) => list.map((o) => o.type).sort();

test("CTR calculation: clicks / impressions, zero impressions → 0", () => {
  assert.equal(ctr(18, 1240), 18 / 1240);
  assert.equal(ctr(0, 0), 0);
});

test("weighted aggregate: CTR from sums and impression-weighted position (not average of averages)", () => {
  const a = aggregate([{ date: "2026-09-01", clicks: 10, impressions: 100, position: 2 }, { date: "2026-09-02", clicks: 0, impressions: 900, position: 20 }]);
  assert.equal(a.clicks, 10);
  assert.equal(a.impressions, 1000);
  assert.equal(a.ctr, 0.01);
  assert.equal(a.position, (2 * 100 + 20 * 900) / 1000); // 18.2, not (2+20)/2 = 11
  assert.equal(a.days, 2);
  assert.equal(aggregate([]).position, null);
});

test("period comparison windows: 28 vs previous 28, contiguous, inclusive", () => {
  assert.deepEqual(period, { start: "2026-08-24", end: "2026-09-20", prevStart: "2026-07-27", prevEnd: "2026-08-23", days: 28 });
  assert.equal(spanDays(period.start, period.end), 28);
  assert.equal(addDays(period.prevEnd, 1), period.start);
  const w7 = comparisonWindows("2026-09-20", 7);
  assert.equal(w7.start, "2026-09-14");
  assert.equal(w7.prevEnd, "2026-09-13");
  assert.ok(isDate("2026-02-28") && !isDate("2026-02-30"));
});

test("zero previous denominator: percentage is null, absolute change kept", () => {
  assert.deepEqual(change(12, 0), { current: 12, previous: 0, abs: 12, pct: null });
  assert.equal(change(15, 10).pct, 0.5);
  const cmp = compareTotals({ clicks: 5, impressions: 50, ctr: 0.1, position: null }, { clicks: 0, impressions: 0, ctr: 0, position: null });
  assert.equal(cmp.clicks.pct, null);
  assert.equal(cmp.position.abs, null);
});

test("high impressions / low CTR uses the site's own CTR baseline for the position range", () => {
  const queries = [Q("a", 60, 600, 5), Q("b", 55, 500, 6), Q("c", 3, 800, 5.5), Q("d", 1, 40, 5)];
  const base = ctrBaselines(queries, 200);
  assert.ok(base["4-10"].ctr > 0.06);
  const out = run({ queries, pages: [] }, null);
  const low = out.filter((o) => o.type === "high_impressions_low_ctr");
  assert.deepEqual(low.map((o) => o.query), ["c"]); // d has too few impressions
  assert.match(low[0].reason, /800 impressions and 3 clicks/);
  assert.match(low[0].recommended_action, /Review title\/meta and SERP intent/);
  assert.doesNotMatch(low[0].recommended_action, /bad meta/i);
});

test("zero clicks at a visible position is flagged; zero clicks at position 80 is not (CTR not the issue)", () => {
  const out = run({ queries: [Q("visible", 0, 300, 6), Q("deep", 0, 5000, 80)], pages: [] }, null);
  const zc = out.filter((o) => o.type === "high_impressions_low_ctr");
  assert.deepEqual(zc.map((o) => o.query), ["visible"]);
  assert.equal(zc[0].evidence.zero_click, true);
});

test("striking distance: positions 4–20 with enough impressions, reason cites evidence, no promise", () => {
  const out = run({ queries: [Q("close", 5, 400, 8.4), Q("top", 50, 400, 2), Q("far", 0, 400, 35), Q("tiny", 0, 10, 9)], pages: [] }, null);
  const sd = out.filter((o) => o.type === "striking_distance");
  assert.deepEqual(sd.map((o) => o.query), ["close"]);
  assert.equal(sd[0].reason, `Query received 400 impressions at average position 8.4 during ${period.start} – ${period.end}.`);
  assert.match(sd[0].recommended_action, /not guaranteed/);
});

test("content decay requires minimum evidence; wording avoids permanence", () => {
  const cur = { queries: [], pages: [P("https://x.com/a", 18, 1240, 7), P("https://x.com/tiny", 1, 20, 9)] };
  const prev = { queries: [], pages: [P("https://x.com/a", 40, 1300, 6), P("https://x.com/tiny", 2, 25, 9)] };
  const out = run(cur, prev).filter((o) => o.type === "content_decay");
  assert.deepEqual(out.map((o) => o.page), ["https://x.com/a"]);
  assert.match(out[0].reason, /received 1,240 impressions and 18 clicks\. In the previous 28-day period .* received 1,300 impressions and 40 clicks/);
  assert.match(out[0].recommended_action, /declined compared with the previous period/);
  assert.doesNotMatch(`${out[0].reason} ${out[0].recommended_action}`, /is declining permanently|permanently declin/);
});

test("low-volume suppression: 2 → 1 clicks and 1 → 0 clicks never produce decay", () => {
  const out = run({ queries: [Q("q", 0, 30, 9)], pages: [P("https://x.com/p", 1, 30, 9)] }, { queries: [Q("q", 1, 40, 9)], pages: [P("https://x.com/p", 2, 40, 9)] });
  assert.equal(out.filter((o) => ["content_decay", "position_decline"].includes(o.type)).length, 0);
});

test("trend detectors are skipped when a period lacks enough days of data", () => {
  const cur = { queries: [], pages: [P("https://x.com/a", 5, 500, 7)] };
  const prev = { queries: [], pages: [P("https://x.com/a", 50, 2000, 6)] };
  assert.equal(run(cur, prev, new Map(), {}, { currentDays: 28, previousDays: 5 }).filter((o) => o.type === "content_decay").length, 0);
  assert.equal(run(cur, prev).filter((o) => o.type === "content_decay").length, 1);
});

test("growth detection: growing query and page are low priority and advise against disruptive changes", () => {
  const out = run({ queries: [Q("rising", 30, 600, 5)], pages: [P("https://x.com/g", 30, 600, 5)] }, { queries: [Q("rising", 10, 300, 7)], pages: [P("https://x.com/g", 10, 300, 7)] });
  const g = out.filter((o) => o.type.startsWith("growing"));
  assert.deepEqual(types(g), ["growing_page", "growing_query"]);
  for (const o of g) { assert.equal(o.priority, "low"); assert.match(o.recommended_action, /Avoid disruptive changes/); }
});

test("new query detection only for queries labeled new_query with enough impressions", () => {
  const labels = new Map([[normalizeQuery("paneles solares para negocio juarez"), { mapping: "new_query", intent: "commercial", brand: "non_branded" }], [normalizeQuery("known"), { mapping: "known_keyword" }], [normalizeQuery("rare"), { mapping: "new_query" }]]);
  const out = run({ queries: [Q("paneles solares para negocio juarez", 2, 150, 12), Q("known", 1, 400, 12), Q("rare", 0, 5, 30)], pages: [] }, null, labels);
  const nq = out.filter((o) => o.type === "new_query");
  assert.deepEqual(nq.map((o) => o.query), ["paneles solares para negocio juarez"]);
  assert.equal(nq[0].evidence.source, "google_search_console");
  assert.match(nq[0].evidence.note, /not a measure of global search volume/);
});

test("page-query mismatch when Google ranks a different page than the strategy target", () => {
  const labels = new Map([[normalizeQuery("instalacion paneles"), { mapping: "known_keyword", intent: "commercial", mapped_page: "https://x.com/servicios/instalacion" }]]);
  const out = run({ queries: [Q("instalacion paneles", 2, 300, 11)], pages: [], queryPages: [{ query: "instalacion paneles", page: "https://x.com/", clicks: 2, impressions: 280, position: 11 }] }, null, labels);
  const mm = out.filter((o) => o.type === "page_query_mismatch");
  assert.equal(mm.length, 1);
  assert.equal(mm[0].evidence.strategy_target_page, "https://x.com/servicios/instalacion");
  assert.equal(mm[0].page, "https://x.com/");
});

test("potential cannibalization needs ≥2 pages each with a meaningful share; not asserted as fact", () => {
  const qp = [{ query: "q", page: "https://x.com/a", clicks: 1, impressions: 60, position: 8 }, { query: "q", page: "https://x.com/b", clicks: 1, impressions: 50, position: 9 }, { query: "q", page: "https://x.com/c", clicks: 0, impressions: 2, position: 40 }];
  const out = run({ queries: [Q("q", 2, 112, 8.6)], pages: [], queryPages: qp }, null).filter((o) => o.type === "potential_cannibalization");
  assert.equal(out.length, 1);
  assert.equal(out[0].evidence.pages.length, 2);
  assert.match(out[0].recommended_action, /not always a problem/);
  const single = run({ queries: [Q("q", 2, 112, 8.6)], pages: [], queryPages: [qp[0], qp[2]] }, null).filter((o) => o.type === "potential_cannibalization");
  assert.equal(single.length, 0);
});

test("opportunity dedup: same type/query/page → same key; reconcile updates instead of duplicating", () => {
  assert.equal(dedupeKey("striking_distance", "Paneles  Solares", "https://www.x.com/a/"), dedupeKey("striking_distance", "paneles solares", "https://x.com/a"));
  const detected = run({ queries: [Q("close", 5, 400, 8.4)], pages: [] }, null);
  const first = reconcile([], detected, { now: "2026-09-21T10:00:00.000Z" });
  assert.equal(first.creates.length, detected.length);
  const existing = first.creates.map((c, i) => ({ id: `id${i}`, ...c }));
  const second = reconcile(existing, detected, { now: "2026-09-22T10:00:00.000Z" });
  assert.equal(second.creates.length, 0);
  assert.equal(second.updates.length, detected.length);
  assert.equal(second.updates[0].detection_count, 2);
  assert.equal(second.updates[0].last_detected_at, "2026-09-22T10:00:00.000Z");
});

test("manual ignore persists across syncs; resolution waits for the persistence window", () => {
  const detected = run({ queries: [Q("close", 5, 400, 8.4)], pages: [] }, null);
  const [c] = reconcile([], detected, { now: "2026-09-01T00:00:00.000Z" }).creates;
  const ignored = { id: "i1", ...c, status: "ignored" };
  const again = reconcile([ignored], detected, { now: "2026-09-02T00:00:00.000Z" });
  assert.equal(again.updates[0].status, undefined); // status untouched → stays ignored
  // Condition disappears: an ignored one is never auto-resolved; a "new" one only after N days.
  assert.equal(reconcile([ignored], [], { now: "2026-09-30T00:00:00.000Z" }).resolves.length, 0);
  const fresh = { id: "n1", ...c, status: "new", last_detected_at: "2026-09-01T00:00:00.000Z" };
  assert.equal(reconcile([fresh], [], { now: "2026-09-03T00:00:00.000Z", resolveAfterDays: 7 }).resolves.length, 0);
  assert.equal(reconcile([fresh], [], { now: "2026-09-10T00:00:00.000Z", resolveAfterDays: 7 }).resolves.length, 1);
  // A resolved one that reappears is reopened.
  const resolved = { id: "r1", ...c, status: "resolved" };
  assert.equal(reconcile([resolved], detected, {}).updates[0].status, "new");
});

test("position decline needs volume in both periods and a real drop", () => {
  const out = run({ queries: [Q("q", 5, 300, 12)], pages: [] }, { queries: [Q("q", 9, 320, 6)], pages: [] });
  assert.equal(out.filter((o) => o.type === "position_decline").length, 1);
  const small = run({ queries: [Q("q", 5, 300, 7)], pages: [] }, { queries: [Q("q", 9, 320, 6)], pages: [] });
  assert.equal(small.filter((o) => o.type === "position_decline").length, 0);
});

test("configurable thresholds override defaults", () => {
  const q = [Q("close", 5, 60, 8.4)];
  assert.equal(run({ queries: q, pages: [] }, null).filter((o) => o.type === "striking_distance").length, 1);
  assert.equal(run({ queries: q, pages: [] }, null, new Map(), { striking: { min_impressions: 100 } }).filter((o) => o.type === "striking_distance").length, 0);
});
