// bunker-seo-analytics engine: claim gsc_sync_jobs → Google Search Console
// (read-only) → idempotent upserts in PocketBase → labels → opportunities.
// Never edits, creates or publishes content.
import { SearchConsoleClient, GoogleError, READONLY_SCOPE, sanitize } from "./google.js";
import { addDays, isDate, spanDays, todayPT, comparisonWindows, SOURCE_TIMEZONE, MAX_HISTORY_DAYS } from "./dates.js";
import { detectOpportunities, reconcile, mergeSettings, normalizeQuery } from "./analytics.js";
import { brandTerms, labelQueries } from "./labels.js";
import { decrypt } from "./secrets.js";

export const WORKER_VERSION = "analytics-0.6.0";
const esc = (v) => String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const nowIso = () => new Date().toISOString();
const RANGE_DAYS = { "7d": 7, "28d": 28, "90d": 90, "3m": 91, "6m": 182 };
export const DATASETS = [
  { name: "site", table: "gsc_site_daily", dimensions: ["date"] },
  { name: "page", table: "gsc_page_daily", dimensions: ["date", "page"] },
  { name: "query", table: "gsc_query_daily", dimensions: ["date", "query"] },
  { name: "query_page", table: "gsc_query_page_daily", dimensions: ["date", "query", "page"] },
];
const UPSERT_BATCH = 1000;

async function one(pb, col, id) {
  if (!id) return null;
  try { return await pb.collection(col).getOne(id); } catch (e) { if (e?.status === 404) return null; throw e; }
}

async function internal(pb, path, body) {
  const r = await pb.send(`/api/bsa/internal/gsc/${path}`, { method: "POST", body, requestKey: null });
  return r.result;
}

export async function claimNextJob(pb) {
  const list = await pb.collection("gsc_sync_jobs").getList(1, 10, { filter: 'status = "queued"', sort: "created_at" });
  for (const c of list.items) {
    const fresh = await one(pb, "gsc_sync_jobs", c.id);
    if (!fresh || fresh.status !== "queued") continue;
    try {
      return await pb.collection("gsc_sync_jobs").update(c.id, { status: "running", attempt: Number(fresh.attempt || 0) + 1, started_at: nowIso(), step: "Starting", updated_at: nowIso() });
    } catch (e) {
      if ([400, 404, 409].includes(e?.status)) continue;
      throw e;
    }
  }
  return null;
}

/** Jobs left "running" by a crashed worker are failed (never silently resumed). */
export async function recoverStale(pb, { logger = console, olderThanMs = 2 * 3600_000 } = {}) {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString().replace("T", " ");
  const list = await pb.collection("gsc_sync_jobs").getFullList({ filter: `status = "running" && updated_at < "${cutoff}"` });
  for (const j of list) {
    await pb.collection("gsc_sync_jobs").update(j.id, { status: "failed", error_code: "WORKER_RESTARTED", error_message: "The analytics worker restarted during this sync. Run it again.", completed_at: nowIso(), updated_at: nowIso() });
    logger.log(`[analytics] recovered stale job ${j.id}`);
  }
}

async function activity(pb, job, website, action, metadata) {
  await pb.collection("activity_logs").create({ organization: job.organization, client: website?.client || "", website: job.website, user: job.triggered_by || "", action, entity_type: "gsc_sync_job", entity_id: job.id, metadata, created_at: nowIso() });
}

export async function notify(pb, fields) {
  const existing = (await pb.collection("notifications").getList(1, 1, { filter: `organization = "${esc(fields.organization)}" && dedupe_key = "${esc(fields.dedupe_key)}"` })).items[0];
  if (existing) {
    await pb.collection("notifications").update(existing.id, { occurrences: Number(existing.occurrences || 1) + 1, body: fields.body || existing.body, updated_at: nowIso() });
    return existing.id;
  }
  const n = await pb.collection("notifications").create({ website: "", severity: "info", link: "", body: "", ...fields, occurrences: 1, created_at: nowIso(), updated_at: nowIso() });
  return n.id;
}

async function progress(pb, job, fields) {
  Object.assign(job, fields);
  await pb.collection("gsc_sync_jobs").update(job.id, { ...fields, updated_at: nowIso() });
}

/** Resolve the date range a job must fetch (never beyond latest final date). */
export function planRange(job, property, latestFinal) {
  if (!latestFinal) return null;
  const earliest = addDays(latestFinal, -(MAX_HISTORY_DAYS - 1));
  let start, end = latestFinal;
  if (job.sync_type === "daily") {
    // Re-fetch the last 3 synced days (Google may still adjust recent final days).
    start = property.last_synced_date && isDate(property.last_synced_date) ? addDays(property.last_synced_date, -3) : addDays(latestFinal, -89);
    if (property.last_synced_date && property.last_synced_date >= latestFinal) return { start: addDays(latestFinal, -2), end: latestFinal, upToDate: true };
  } else if (job.range_label === "custom") {
    start = job.start_date; end = job.end_date > latestFinal ? latestFinal : job.end_date;
  } else {
    const days = RANGE_DAYS[job.range_label] || 90;
    start = addDays(latestFinal, -(days - 1));
  }
  if (start < earliest) start = earliest;
  if (!isDate(start) || !isDate(end) || start > end) return null;
  return { start, end };
}

/** Split [start, end] into windows so a single dataset never needs millions of rows at once. */
export function windows(start, end, size) {
  const out = [];
  for (let s = start; s <= end; s = addDays(s, size)) {
    const e = addDays(s, size - 1);
    out.push({ start: s, end: e > end ? end : e });
  }
  return out;
}

export function rowToRecord(dataset, row, searchType, dataState) {
  const keys = row.keys || [];
  const rec = { date: keys[0], search_type: searchType, clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position };
  if (dataset.name === "site") rec.data_state = dataState;
  if (dataset.name === "page") rec.page = keys[1];
  if (dataset.name === "query") { rec.query = keys[1]; rec.normalized_query = normalizeQuery(keys[1]); }
  if (dataset.name === "query_page") { rec.query = keys[1]; rec.normalized_query = normalizeQuery(keys[1]); rec.page = keys[2]; }
  return rec;
}

export async function processJob(pb, job, { env = process.env, key, oauth = {}, logger = console, clientFactory } = {}) {
  const website = await one(pb, "websites", job.website);
  const property = await one(pb, "gsc_properties", job.property);
  const fail = async (code, message, extra = {}) => {
    await progress(pb, job, { status: "failed", error_code: code, error_message: sanitize(message), completed_at: nowIso(), step: "Failed", ...extra });
    if (website) await activity(pb, job, website, "GSC_SYNC_FAILED", { job: job.id, error_code: code, sync_type: job.sync_type });
    if (property) {
      const failures = Number(property.consecutive_failures || 0) + 1;
      await pb.collection("gsc_properties").update(property.id, { last_sync_at: nowIso(), last_sync_status: "failed", consecutive_failures: failures, updated_at: nowIso() });
      if (failures >= 3) await notify(pb, { organization: job.organization, website: job.website, kind: "gsc_sync_failing", severity: "warning", title: "Search Console sync keeps failing", body: `${failures} consecutive syncs failed for ${property.site_url}: ${sanitize(message)}`, dedupe_key: `gsc_sync_failing:${property.id}`, link: `/websites/${job.website}/search-console` });
    }
    return { status: "failed", code };
  };
  if (!website || !property) return fail("NOT_FOUND", "Website or property no longer exists");
  // Defense in depth: every relation must belong to the same tenant/website.
  if (property.organization !== website.organization || job.organization !== website.organization || property.website !== website.id || !property.selected) return fail("TENANT_MISMATCH", "Property is not mapped to this website");
  if (property.status !== "active") return fail("ACCESS_LOST", "Search Console access to this property is not active");
  const connection = await one(pb, "gsc_connections", property.connection);
  if (!connection || connection.organization !== website.organization) return fail("TENANT_MISMATCH", "Connection does not belong to this organization");
  if (connection.status !== "connected") return fail("REAUTH_REQUIRED", "Search Console needs to be reconnected");
  // Hidden field: only readable with superuser credentials (this worker).
  const enc = connection.encrypted_refresh_token;
  if (!enc) return fail("REAUTH_REQUIRED", "No stored authorization. Reconnect Search Console.");

  await activity(pb, job, website, "GSC_SYNC_STARTED", { job: job.id, sync_type: job.sync_type, range: job.range_label || null, property: property.site_url });
  const client = clientFactory ? clientFactory({ refreshToken: decrypt(enc, key) }) : new SearchConsoleClient({ clientId: oauth.client_id, clientSecret: oauth.client_secret, refreshToken: decrypt(enc, key), env, logger });
  const warnings = [];
  const datasetsMeta = {};
  try {
    await progress(pb, job, { step: "Checking available finalized data", progress: 2 });
    await client.token();
    if (client.grantedScope && !client.grantedScope.split(/\s+/).includes(READONLY_SCOPE)) throw new GoogleError("SCOPE_MISSING", "Search Console read-only scope is not granted");
    await pb.collection("gsc_connections").update(connection.id, { last_refresh_at: nowIso(), last_error: "", updated_at: nowIso() });
    const latest = await client.latestFinalDate(property.site_url, todayPT());
    if (!latest.date) {
      warnings.push({ code: "NO_DATA", message: "Search Console returned no finalized data for the last 14 days." });
      await pb.collection("gsc_properties").update(property.id, { last_verified_at: nowIso(), last_sync_at: nowIso(), last_sync_status: "completed_with_warnings", consecutive_failures: 0, source_timezone: SOURCE_TIMEZONE, updated_at: nowIso() });
      await progress(pb, job, { status: "completed_with_warnings", step: "No finalized data available", progress: 100, warnings, completed_at: nowIso(), api_requests: client.requests, data_state: "final" });
      await activity(pb, job, website, "GSC_SYNC_COMPLETED", { job: job.id, rows_stored: 0, warnings: warnings.map((w) => w.code) });
      return { status: "completed_with_warnings" };
    }
    const plan = planRange(job, property, latest.date);
    if (!plan) return fail("INVALID_RANGE", "The requested range has no finalized data");
    await progress(pb, job, { start_date: plan.start, end_date: plan.end, step: `Data available through ${latest.date}`, progress: 5 });

    const searchType = job.search_type || "web";
    const maxRows = Math.max(25000, Number(env.GSC_MAX_ROWS_PER_DATASET || 1_000_000));
    const windowDays = Math.max(1, Number(env.GSC_WINDOW_DAYS || 7));
    let received = 0, stored = 0, requested = 0, allComplete = true;
    const wins = windows(plan.start, plan.end, windowDays);
    const totalSteps = DATASETS.length * wins.length;
    let stepNo = 0;
    for (const ds of DATASETS) {
      const meta = { rows_requested: 0, rows_returned: 0, rows_stored: 0, pages: 0, pagination_completed: true, data_state: "final", windows: wins.length };
      for (const w of wins) {
        stepNo++;
        await progress(pb, job, { step: `Downloading ${ds.name} rows ${w.start} → ${w.end}`, progress: Math.min(90, 5 + Math.round((stepNo / totalSteps) * 80)) });
        const res = await client.queryAll(property.site_url, { startDate: w.start, endDate: w.end, dimensions: ds.dimensions, type: searchType, dataState: "final", maxRows });
        meta.rows_requested += res.rowsRequested; meta.rows_returned += res.rows.length; meta.pages += res.pages;
        if (!res.paginationCompleted) { meta.pagination_completed = false; allComplete = false; warnings.push({ code: "ROW_CAP_REACHED", message: `${ds.name} ${w.start}–${w.end}: stopped at ${res.rows.length} rows (safety cap).` }); }
        const records = res.rows.map((r) => rowToRecord(ds, r, searchType, "final")).filter((r) => isDate(r.date));
        for (let i = 0; i < records.length; i += UPSERT_BATCH) {
          const out = await internal(pb, "upsert", { table: ds.table, website: website.id, property: property.id, rows: records.slice(i, i + UPSERT_BATCH) });
          meta.rows_stored += out.stored;
        }
      }
      received += meta.rows_returned; stored += meta.rows_stored; requested += meta.rows_requested;
      datasetsMeta[ds.name] = meta;
      await progress(pb, job, { rows_received: received, rows_stored: stored, rows_requested: requested, datasets: datasetsMeta, api_requests: client.requests });
    }
    warnings.push({ code: "ANONYMIZED_QUERIES", message: "Search Console may omit anonymized or lower-volume queries; query totals can be lower than site totals." });

    const isFirst = !property.first_data_date || plan.start < property.first_data_date;
    await pb.collection("gsc_properties").update(property.id, {
      latest_final_date: latest.date, last_synced_date: !property.last_synced_date || plan.end > property.last_synced_date ? plan.end : property.last_synced_date,
      ...(isFirst ? { first_data_date: plan.start } : {}), source_timezone: SOURCE_TIMEZONE, last_verified_at: nowIso(), updated_at: nowIso(),
    });

    await progress(pb, job, { step: "Labeling queries and detecting opportunities", progress: 92 });
    const opp = await analyze(pb, { website, property: { ...property, latest_final_date: latest.date }, logger });
    const status = allComplete && !warnings.some((w) => w.code === "ROW_CAP_REACHED") ? "completed" : "completed_with_warnings";
    await pb.collection("gsc_properties").update(property.id, { last_sync_at: nowIso(), last_sync_status: status, consecutive_failures: 0, updated_at: nowIso() });
    await progress(pb, job, {
      status, step: `Done — data through ${latest.date}`, progress: 100, completed_at: nowIso(), warnings, datasets: { ...datasetsMeta, opportunities: opp, latest_final_date: latest.date, latest_method: latest.method },
      pagination_completed: allComplete, data_state: "final", api_requests: client.requests,
    });
    await activity(pb, job, website, "GSC_SYNC_COMPLETED", { job: job.id, start_date: plan.start, end_date: plan.end, latest_final_date: latest.date, rows_received: received, rows_stored: stored, opportunities: opp });
    logger.log(`[analytics] job ${job.id} ${status} ${plan.start}..${plan.end} received=${received} stored=${stored}`);
    return { status, received, stored, opportunities: opp };
  } catch (e) {
    const code = e?.code || "SYNC_FAILED";
    if (code === "REAUTH_REQUIRED" || code === "SCOPE_MISSING") {
      await pb.collection("gsc_connections").update(connection.id, { status: "reauth_required", last_error: sanitize(e.message), updated_at: nowIso() });
      await notify(pb, { organization: job.organization, website: job.website, kind: "gsc_reauth", severity: "critical", title: "Reconnect Search Console", body: `Google rejected the stored authorization for ${connection.google_account_email}. Syncing is paused until you reconnect.`, dedupe_key: `gsc_reauth:${connection.id}`, link: `/websites/${job.website}/search-console` });
    }
    if (code === "ACCESS_DENIED" || code === "NOT_FOUND") {
      await pb.collection("gsc_properties").update(property.id, { status: "access_lost", updated_at: nowIso() });
      await notify(pb, { organization: job.organization, website: job.website, kind: "gsc_access_lost", severity: "warning", title: "Search Console access lost", body: `Google no longer grants access to ${property.site_url}. Historical data is kept.`, dedupe_key: `gsc_access_lost:${property.id}`, link: `/websites/${job.website}/search-console` });
    }
    logger.error(`[analytics] job ${job.id} failed ${code} ${sanitize(e?.message)}`);
    return fail(code === "ACCESS_DENIED" || code === "NOT_FOUND" ? "ACCESS_LOST" : code, e?.message || "Sync failed", { warnings, datasets: datasetsMeta, api_requests: client.requests });
  }
}

/** Build labels + detect/reconcile opportunities for one website (28 vs previous 28). */
export async function analyze(pb, { website, property, logger = console, now = nowIso() }) {
  const settings = mergeSettings(website.analytics_settings || {});
  const latest = property.latest_final_date;
  if (!isDate(latest)) return { skipped: "no_data" };
  const period = comparisonWindows(latest, settings.window_days);
  const flags = await pb.collection("gsc_data_quality_flags").getFullList({ filter: `website = "${esc(website.id)}" && active = true && exclude_from_opportunities = true` });
  const exclude = flags.map((f) => ({ start: f.start_date, end: f.end_date }));
  const agg = (kind, start, end, limit) => internal(pb, "aggregate", { kind, website: website.id, property: property.id, start, end, limit, exclude });
  const [siteCur, sitePrev, qCur, qPrev, pCur, pPrev, qp] = await Promise.all([
    agg("site", period.start, period.end), agg("site", period.prevStart, period.prevEnd),
    agg("queries", period.start, period.end, 5000), agg("queries", period.prevStart, period.prevEnd, 5000),
    agg("pages", period.start, period.end, 2000), agg("pages", period.prevStart, period.prevEnd, 2000),
    agg("query_pages", period.start, period.end, 20000),
  ]);

  // Phase 3 context (read-only): latest strategy keywords, brand facts, locations.
  const client = await one(pb, "clients", website.client);
  const version = (await pb.collection("strategy_versions").getList(1, 1, { filter: `website = "${esc(website.id)}"`, sort: "-version" })).items[0];
  const keywords = version ? await pb.collection("keywords").getFullList({ filter: `strategy_version = "${esc(version.id)}" && status != "ignored"`, fields: "id,keyword,normalized_keyword,recommended_target_page,existing_target_page" }) : [];
  const pageIds = [...new Set(keywords.map((k) => k.existing_target_page).filter(Boolean))];
  const pageUrl = {};
  for (let i = 0; i < pageIds.length; i += 50) {
    const chunk = pageIds.slice(i, i + 50);
    for (const p of await pb.collection("website_pages").getFullList({ filter: chunk.map((id) => `id = "${esc(id)}"`).join(" || "), fields: "id,url" })) pageUrl[p.id] = p.url;
  }
  const origin = `https://${String(website.domain || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`;
  const kw = keywords.map((k) => {
    let target = k.existing_target_page ? pageUrl[k.existing_target_page] || "" : k.recommended_target_page || "";
    if (target.startsWith("/")) target = origin + target;
    return { id: k.id, keyword: k.keyword, normalized_keyword: k.normalized_keyword, target_page_url: /^https?:\/\//.test(target) ? target : "" };
  });
  const facts = await pb.collection("business_facts").getFullList({ filter: `website = "${esc(website.id)}" && (fact_type = "business_name" || fact_type = "brand")`, fields: "fact_type,value,verification_state" }).catch(() => []);
  const brand = brandTerms({ businessName: client?.business_name, facts, domain: website.domain });
  const locations = [client?.primary_location, ...(Array.isArray(client?.service_areas) ? client.service_areas : [])].filter(Boolean).map(String);
  const existingLabels = await pb.collection("gsc_query_labels").getFullList({ filter: `website = "${esc(website.id)}" && brand_override != ""`, fields: "normalized_query,brand_override" });
  const overrides = new Map(existingLabels.map((l) => [l.normalized_query, l.brand_override]));
  const allQueries = [...qCur, ...qPrev];
  const labels = labelQueries(allQueries, { keywords: kw, brand, locations, overrides });
  for (let i = 0; i < labels.length; i += 1000) await internal(pb, "labels", { website: website.id, rows: labels.slice(i, i + 1000) });
  const labelMap = new Map(labels.map((l) => [l.normalized_query, l]));

  const detected = detectOpportunities({
    period, settings,
    current: { queries: qCur, pages: pCur, queryPages: qp },
    previous: { queries: qPrev, pages: pPrev },
    coverage: { currentDays: siteCur.days, previousDays: sitePrev.days },
    labels: labelMap,
  });
  const existing = await pb.collection("analytics_opportunities").getFullList({ filter: `website = "${esc(website.id)}"`, fields: "id,dedupe_key,status,detection_count,first_detected_at,last_detected_at" });
  const { creates, updates, resolves } = reconcile(existing, detected, { now, resolveAfterDays: settings.resolve_after_days });
  const tenant = { organization: website.organization, client: website.client, website: website.id };
  let notified = 0;
  for (const c of creates) {
    const rec = await pb.collection("analytics_opportunities").create({ ...tenant, ...c });
    if (c.priority === "high" && !["growing_query", "growing_page", "impression_growth"].includes(c.type) && notified < 3) {
      await notify(pb, { organization: website.organization, website: website.id, kind: "analytics_opportunity", severity: "info", title: `New SEO opportunity: ${c.type.replace(/_/g, " ")}`, body: c.reason.slice(0, 500), dedupe_key: `analytics_opp:${rec.id}`, link: `/websites/${website.id}/analytics/opportunities` });
      notified++;
    }
  }
  for (const u of updates) { const { id, ...f } = u; await pb.collection("analytics_opportunities").update(id, f); }
  for (const r of resolves) { const { id, ...f } = r; await pb.collection("analytics_opportunities").update(id, f); }
  logger.log(`[analytics] ${website.id} opportunities created=${creates.length} updated=${updates.length} resolved=${resolves.length}`);
  return { window: { start: period.start, end: period.end, prevStart: period.prevStart, prevEnd: period.prevEnd }, detected: detected.length, created: creates.length, updated: updates.length, resolved: resolves.length, labeled: labels.length };
}

/**
 * Daily scheduler: once per PT day after `hour` (UTC), queue a daily sync for
 * every selected, active property whose connection is healthy. Deduplicated
 * by a deterministic key so restarts never double-queue.
 */
export async function scheduleDaily(pb, { now = new Date(), hourUtc = 10, logger = console } = {}) {
  if (now.getUTCHours() < hourUtc) return 0;
  const day = todayPT(now);
  const props = await pb.collection("gsc_properties").getFullList({ filter: 'selected = true && status = "active" && website != ""' });
  let queued = 0;
  for (const p of props) {
    const c = await one(pb, "gsc_connections", p.connection);
    if (!c || c.status !== "connected" || c.organization !== p.organization) continue;
    const key = `daily:${p.id}:${day}`;
    const exists = (await pb.collection("gsc_sync_jobs").getList(1, 1, { filter: `dedupe_key = "${esc(key)}" || (property = "${esc(p.id)}" && (status = "queued" || status = "running"))` })).items[0];
    if (exists) continue;
    try {
      await pb.collection("gsc_sync_jobs").create({ organization: p.organization, website: p.website, property: p.id, status: "queued", sync_type: "daily", range_label: "daily", search_type: "web", data_state: "final", step: "Queued (daily)", progress: 0, rows_requested: 0, rows_received: 0, rows_stored: 0, api_requests: 0, attempt: 0, dedupe_key: key, created_at: nowIso(), updated_at: nowIso() });
      queued++;
    } catch (e) {
      if (e?.status !== 400) throw e; // unique index collision = already queued
    }
  }
  if (queued) logger.log(`[analytics] scheduled ${queued} daily sync(s) for ${day}`);
  return queued;
}

export { spanDays };
