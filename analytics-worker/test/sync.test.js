import test from "node:test";
import assert from "node:assert/strict";
import { SearchConsoleClient, withRetry, sanitize, GoogleError, MAX_ROW_LIMIT, READONLY_SCOPE } from "../src/google.js";
import { labelQueries, mapQuery, brandOf, brandTerms } from "../src/labels.js";
import { planRange, windows, rowToRecord, DATASETS } from "../src/engine.js";
import { encrypt, decrypt } from "../src/secrets.js";

const noSleep = async () => {};
const quiet = { log() {}, error() {} };
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Controlled Google API mock (token + Search Analytics) with call recording. */
function mockGoogle({ rows = 0, pageFail = [], tokenFail = null, scope = `openid email ${READONLY_SCOPE}`, finalDates = ["2026-09-20"] } = {}) {
  const calls = [];
  let queryCalls = 0;
  const fetchImpl = async (url, init) => {
    const body = init?.body ? (String(init.body).startsWith("{") ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(String(init.body)))) : null;
    calls.push({ url: String(url), method: init?.method, body, auth: init?.headers?.authorization });
    if (String(url).includes("/token")) {
      if (tokenFail) return tokenFail();
      return json(200, { access_token: `ya29.token${calls.length}`, expires_in: 3599, scope });
    }
    if (String(url).endsWith("/sites")) return json(200, { siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }] });
    if (String(url).includes("/searchAnalytics/query")) {
      queryCalls++;
      const f = pageFail.shift();
      if (f) return f();
      if (body.dimensions.length === 1 && body.dimensions[0] === "date") {
        const inRange = finalDates.filter((d) => d >= body.startDate && d <= body.endDate);
        return json(200, { rows: inRange.map((d) => ({ keys: [d], clicks: 1, impressions: 10, ctr: 0.1, position: 5 })) });
      }
      const remaining = Math.max(0, rows - body.startRow);
      const n = Math.min(body.rowLimit, remaining);
      return json(200, n ? { rows: Array.from({ length: n }, (_, i) => ({ keys: ["2026-09-01", `q${body.startRow + i}`], clicks: 1, impressions: 3, ctr: 1 / 3, position: 4.5 })) } : {});
    }
    return json(404, {});
  };
  return { fetchImpl, calls, get queryCalls() { return queryCalls; } };
}
const client = (g, extra = {}) => new SearchConsoleClient({ clientId: "cid", clientSecret: "csecret", refreshToken: "1//refresh", fetchImpl: g.fetchImpl, sleep: noSleep, logger: quiet, env: {}, ...extra });

test("pagination: rowLimit = max, startRow advances, stops when fewer rows than requested", async () => {
  const g = mockGoogle({ rows: 60000 });
  const r = await client(g).queryAll("sc-domain:example.com", { startDate: "2026-09-01", endDate: "2026-09-07", dimensions: ["date", "query"] });
  const q = g.calls.filter((c) => c.url.includes("searchAnalytics"));
  assert.deepEqual(q.map((c) => c.body.startRow), [0, 25000, 50000]);
  assert.ok(q.every((c) => c.body.rowLimit === MAX_ROW_LIMIT && c.body.dataState === "final" && c.body.type === "web"));
  assert.equal(r.rows.length, 60000);
  assert.equal(r.paginationCompleted, true);
  assert.equal(r.rowsRequested, 75000);
});

test("pagination: exact multiple ends on an empty page; empty property returns 0 rows after 1 call", async () => {
  const g = mockGoogle({ rows: 50000 });
  const r = await client(g).queryAll("sc-domain:example.com", { startDate: "2026-09-01", endDate: "2026-09-07", dimensions: ["date", "query"] });
  assert.equal(r.pages, 3);
  assert.equal(r.rows.length, 50000);
  const e = mockGoogle({ rows: 0 });
  const r0 = await client(e).queryAll("sc-domain:example.com", { startDate: "2026-09-01", endDate: "2026-09-07", dimensions: ["date", "page"] });
  assert.equal(r0.pages, 1);
  assert.equal(r0.rows.length, 0);
  assert.equal(r0.paginationCompleted, true);
});

test("pagination: hard page cap prevents runaway loops and reports truncation", async () => {
  const g = mockGoogle({ rows: 10_000_000 });
  const r = await client(g).queryAll("sc-domain:example.com", { startDate: "2026-09-01", endDate: "2026-09-07", dimensions: ["date", "query"], maxRows: 50000 });
  assert.equal(r.pages, 2);
  assert.equal(r.paginationCompleted, false);
  assert.equal(r.truncated, true);
});

test("retry 429 (Retry-After honored) and 5xx with bounded exponential backoff", async () => {
  const waits = [];
  const g = mockGoogle({ rows: 10, pageFail: [() => json(429, { error: { status: "RESOURCE_EXHAUSTED" } }, { "retry-after": "7" }), () => json(503, { error: { message: "backend" } })] });
  const r = await client(g, { sleep: async (ms) => { waits.push(ms); } }).queryAll("sc-domain:example.com", { startDate: "2026-09-01", endDate: "2026-09-02", dimensions: ["date", "query"] });
  assert.equal(r.rows.length, 10);
  assert.equal(waits.length, 2);
  assert.ok(waits[0] >= 7000);
  let n = 0;
  await assert.rejects(withRetry(async () => { n++; throw new GoogleError("GOOGLE_UNAVAILABLE", "x", { retryable: true }); }, { attempts: 4, sleep: noSleep }), /x/);
  assert.equal(n, 4);
});

test("network failures retry; non-retryable errors fail immediately", async () => {
  let n = 0;
  const flaky = async (url, init) => { if (String(url).includes("searchAnalytics") && n++ < 2) throw new TypeError("fetch failed"); return mockGoogle({ rows: 3 }).fetchImpl(url, init); };
  const r = await client({ fetchImpl: flaky }).queryAll("sc-domain:example.com", { startDate: "2026-09-01", endDate: "2026-09-02", dimensions: ["date", "query"] });
  assert.equal(r.rows.length, 3);
  const g = mockGoogle({ pageFail: [() => json(403, { error: { message: "User does not have sufficient permission" } })] });
  await assert.rejects(client(g).queryAll("sc-domain:example.com", { startDate: "2026-09-01", endDate: "2026-09-02", dimensions: ["date"] }), (e) => e.code === "ACCESS_DENIED");
  assert.equal(g.queryCalls, 1);
});

test("OAuth refresh: access token cached, refreshed server-side; expired access token refreshed once", async () => {
  const g = mockGoogle({ rows: 1, pageFail: [() => json(401, { error: { status: "UNAUTHENTICATED" } })] });
  const c = client(g);
  await c.queryAll("sc-domain:example.com", { startDate: "2026-09-01", endDate: "2026-09-02", dimensions: ["date", "query"] });
  const tokenCalls = g.calls.filter((x) => x.url.includes("/token"));
  assert.equal(tokenCalls.length, 2);
  assert.equal(tokenCalls[0].body.grant_type, "refresh_token");
  assert.equal(tokenCalls[0].body.refresh_token, "1//refresh");
  await c.listSites();
  assert.equal(g.calls.filter((x) => x.url.includes("/token")).length, 2); // cached
});

test("revoked refresh token → REAUTH_REQUIRED without hammering Google", async () => {
  let tokenCalls = 0;
  const g = mockGoogle({ tokenFail: () => { tokenCalls++; return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }); } });
  await assert.rejects(client(g).token(), (e) => e.code === "REAUTH_REQUIRED" && !/1\/\/refresh/.test(e.message));
  assert.equal(tokenCalls, 1);
});

test("latest finalized date detection uses final rows, never assumes yesterday", async () => {
  const g = mockGoogle({ finalDates: ["2026-09-17", "2026-09-19", "2026-09-18"] });
  const r = await client(g).latestFinalDate("sc-domain:example.com", "2026-09-24");
  assert.deepEqual(r, { date: "2026-09-19", method: "final_rows" });
  const empty = mockGoogle({ finalDates: [] });
  const r2 = await client(empty).latestFinalDate("sc-domain:example.com", "2026-09-24");
  assert.equal(r2.date, null);
  // Low-volume site: last impression 3 months ago → found via the history probe, not reported as "no data".
  const old = mockGoogle({ finalDates: ["2026-05-02", "2026-06-11"] });
  assert.deepEqual(await client(old).latestFinalDate("sc-domain:example.com", "2026-09-24"), { date: "2026-06-11", method: "final_rows_history" });
});

test("date range validation rejects inverted / malformed ranges before calling Google", async () => {
  const g = mockGoogle();
  await assert.rejects(client(g).queryAll("x", { startDate: "2026-09-10", endDate: "2026-09-01", dimensions: ["date"] }), (e) => e.code === "INVALID_RANGE");
  await assert.rejects(client(g).queryAll("x", { startDate: "2026-02-30", endDate: "2026-03-01", dimensions: ["date"] }), (e) => e.code === "INVALID_RANGE");
  assert.equal(g.calls.length, 0);
});

test("planRange: never beyond latest final date; daily re-fetches last 3 days; custom clamps", () => {
  assert.deepEqual(planRange({ sync_type: "initial", range_label: "90d" }, {}, "2026-09-20"), { start: "2026-06-23", end: "2026-09-20" });
  assert.deepEqual(planRange({ sync_type: "daily" }, { last_synced_date: "2026-09-18" }, "2026-09-20"), { start: "2026-09-15", end: "2026-09-20" });
  assert.equal(planRange({ sync_type: "manual", range_label: "custom", start_date: "2026-09-01", end_date: "2026-09-30" }, {}, "2026-09-20").end, "2026-09-20");
  assert.equal(planRange({ sync_type: "manual", range_label: "28d" }, {}, null), null);
  assert.equal(planRange({ sync_type: "backfill", range_label: "custom", start_date: "2020-01-01", end_date: "2026-09-20" }, {}, "2026-09-20").start, "2025-05-23");
  assert.deepEqual(windows("2026-09-01", "2026-09-10", 7), [{ start: "2026-09-01", end: "2026-09-07" }, { start: "2026-09-08", end: "2026-09-10" }]);
});

test("row mapping keeps Google values verbatim (site/page/query/query-page) and final state", () => {
  const row = { keys: ["2026-09-01", "Paneles  Solares", "https://x.com/a"], clicks: 3, impressions: 41, ctr: 0.07317073170731707, position: 6.829268292682927 };
  const qp = rowToRecord(DATASETS.find((d) => d.name === "query_page"), row, "web", "final");
  assert.deepEqual(qp, { date: "2026-09-01", search_type: "web", clicks: 3, impressions: 41, ctr: 0.07317073170731707, position: 6.829268292682927, query: "Paneles  Solares", normalized_query: "paneles solares", page: "https://x.com/a" });
  const site = rowToRecord(DATASETS[0], { keys: ["2026-09-01"], clicks: 1, impressions: 2, ctr: 0.5, position: 3 }, "web", "final");
  assert.equal(site.data_state, "final");
  assert.equal(site.page, undefined);
});

test("errors are sanitized: tokens never appear in stored messages", () => {
  const s = sanitize('failed access_token=ya29.AAA refresh_token: 1//0gSECRET client_secret="abc" Bearer ya29.XYZ');
  assert.doesNotMatch(s, /ya29\.AAA|1\/\/0gSECRET|abc|ya29\.XYZ/);
});

test("refresh token encryption is compatible with PocketBase $security (AES-256-GCM)", () => {
  const key = "0123456789abcdef0123456789abcdef";
  // Produced by PocketBase 0.40 $security.encrypt("refresh-abc", key).
  assert.equal(decrypt("J672AzWYetdGUB2dpCn8+X+R/1RkAL9RCcxaLfk4eF/Eb0NPMvIf", key), "refresh-abc");
  const enc = encrypt("1//secret", key);
  assert.notEqual(enc, "1//secret");
  assert.equal(decrypt(enc, key), "1//secret");
  assert.throws(() => decrypt(enc, "ffffffffffffffffffffffffffffffff"));
});

test("Phase 3 mapping: known keyword / related variant / new query / unmapped", () => {
  const kws = [{ id: "k1", keyword: "paneles solares ciudad juarez", normalized_keyword: "paneles solares ciudad juarez" }, { id: "k2", keyword: "instalacion de paneles solares" }];
  assert.equal(mapQuery("Paneles Solares Ciudad Juárez", kws).mapping, "known_keyword");
  assert.equal(mapQuery("paneles solares juarez ciudad precio", kws).mapping, "related_variant");
  assert.equal(mapQuery("baterias litio", kws).mapping, "new_query");
  assert.equal(mapQuery("anything", []).mapping, "unmapped");
});

test("branded classification from Phase 3 data with manual override", () => {
  const terms = brandTerms({ businessName: "Tlaloc SolFuturo", facts: [{ fact_type: "brand", value: "SolFuturo", verification_state: "verified" }], domain: "tlalocsolfuturo.com" });
  assert.equal(brandOf("tlaloc solfuturo telefono", terms), "branded");
  assert.equal(brandOf("solfuturo", terms), "branded");
  assert.equal(brandOf("paneles solares juarez", terms), "non_branded");
  assert.equal(brandOf("paneles solares juarez", terms, "branded"), "branded");
  assert.equal(brandOf("x", []), "unknown");
  const labels = labelQueries([{ query: "Paneles solares" }, { query: "paneles  solares" }], { keywords: [], brand: terms });
  assert.equal(labels.length, 1); // deduplicated by normalized query
  assert.equal(labels[0].source, "google_search_console");
});
