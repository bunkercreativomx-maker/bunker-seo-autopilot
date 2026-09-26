// bunker-seo-autopilot engine — orchestration only.
//
// Loads REAL state from PocketBase, derives signals, runs the deterministic
// decision engine, records decisions/actions with evidence, and executes
// allowed actions ONLY through the existing Phase 2–5 entry points (via the
// /api/bsa/internal/autopilot/execute hook, which re-validates policy, tenant,
// kill switches and delegates to startGeneration / requestPublish / ...).
// It never approves content, verifies facts, edits websites or changes
// publishing targets. Long waits (human approval) park the run; record hooks
// enqueue triggers and the next worker tick resumes the same run.
import { deriveSignals } from "./signals.js";
import { decide, summarize, circuitGroup } from "./decide.js";
import { classifyError, retryable } from "./signals.js";

export const WORKER_VERSION = "bunker-seo-autopilot/0.7.0";
export const MAX_CYCLES_PER_RUN = 20;
export const CIRCUIT_THRESHOLD = 3;
export const MAX_TRANSIENT_ATTEMPTS = 3;
const DAY = 86_400_000;
const HOT = ["queued", "collecting_signals", "evaluating", "planning", "executing"];
const PARKED = ["waiting_for_approval", "monitoring"];
const esc = (v) => String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const iso = (ms) => new Date(ms).toISOString();
const pbDate = (ms) => iso(ms).replace("T", " ");
const DEFAULTS = {
  enabled: false, mode: "OFF", paused: false, schedule: "weekly",
  allowed_actions: ["CRAWL", "STRATEGY_REFRESH", "GENERATE_CONTENT", "RECHECK_CONTENT", "REQUEST_REVISION", "PUBLISH", "VERIFY_PUBLICATION", "UPDATE_PUBLICATION", "NOTIFY_HUMAN", "WAIT"], allowed_environments: ["staging"],
  max_actions_per_day: 10, max_content_jobs_per_day: 1, max_content_jobs_per_week: 3, max_publications_per_week: 3, max_revision_jobs_per_article: 1,
  max_strategy_refresh_per_week: 1, max_crawls_per_week: 1, max_ai_budget_daily: 5, max_ai_budget_monthly: 50, max_ai_calls_daily: 60, max_ai_tokens_daily: 2_000_000,
  require_human_publish_approval: true, publish_after_human_approval: false, pause_on_high_risk: true, pause_on_fact_failure: true, pause_on_integration_error: true,
  cooldown_hours: 24, optimization_cooldown_days: 28, crawl_max_age_days: 14, strategy_max_age_days: 30, approval_reminder_days: 3, timezone: "America/Ciudad_Juarez",
  auto_pick_opportunities: false,
  auto_publish_safe: false,
};

export class Engine {
  constructor(pb, { now = () => Date.now(), logger = console, workerId = "autopilot-1", execute = null, leaseSeconds = 180, staleQueueMs = 30 * 60_000, telegram = null, appUrl = "", images = null } = {}) {
    this.pb = pb;
    this.images = images;
    this.telegram = telegram;
    this.appUrl = String(appUrl || "").replace(/\/+$/, "");
    this.now = now;
    this.logger = logger;
    this.workerId = workerId;
    this.leaseSeconds = leaseSeconds;
    this.staleQueueMs = staleQueueMs;
    // Injectable for tests; default calls the trusted PocketBase hook.
    this.execute = execute || ((body) => this.internal("execute", body));
  }

  async internal(path, body) {
    const r = await this.pb.send(`/api/bsa/internal/autopilot/${path}`, { method: "POST", body, requestKey: null });
    return r.result;
  }

  col(name) { return this.pb.collection(name); }

  async one(name, id) {
    if (!id) return null;
    try { return await this.col(name).getOne(id, { requestKey: null }); } catch (e) { if (e?.status === 404) return null; throw e; }
  }

  async first(name, filter, opts = {}) {
    const r = await this.col(name).getList(1, 1, { filter, requestKey: null, ...opts });
    return r.items[0] || null;
  }

  async all(name, filter, opts = {}) {
    return this.col(name).getFullList({ filter, batch: 500, requestKey: null, ...opts });
  }

  async count(name, filter) {
    const r = await this.col(name).getList(1, 1, { filter, fields: "id", requestKey: null, skipTotal: false });
    return r.totalItems;
  }

  ts() { return iso(this.now()); }

  // ------------------------------------------------------------ audit / events
  async audit(scope, action, entityType, entityId, metadata = {}) {
    await this.col("activity_logs").create({ organization: scope.organization, client: scope.client || "", website: scope.website || "", user: "", action, entity_type: entityType, entity_id: entityId, metadata: { via: "autopilot_worker", ...metadata }, created_at: this.ts() }, { requestKey: null });
  }

  async event(run, kind, message, details = {}, action = "") {
    await this.col("autopilot_run_events").create({ organization: run.organization, client: run.client, website: run.website, run: run.id, action, kind, message: String(message).slice(0, 1000), details, at: this.ts() }, { requestKey: null });
  }

  async notify(scope, fields) {
    const key = `${scope.website || ""}:${fields.dedupe_key}`.slice(0, 200);
    const existing = await this.first("notifications", `organization = "${esc(scope.organization)}" && dedupe_key = "${esc(key)}"`);
    if (existing) {
      // Cooldown: the same issue bumps a counter instead of a new notification.
      await this.col("notifications").update(existing.id, { occurrences: Number(existing.occurrences || 1) + 1, read_at: fields.reopen ? "" : existing.read_at, updated_at: this.ts() }, { requestKey: null });
      return existing.id;
    }
    const n = await this.col("notifications").create({ organization: scope.organization, website: scope.website || "", kind: fields.kind, severity: fields.severity || "info", title: fields.title, body: fields.body || "", link: fields.link || "", dedupe_key: key, occurrences: 1, created_at: this.ts(), updated_at: this.ts() }, { requestKey: null });
    return n.id;
  }

  // Short human notice (Telegram). Deduplicated by the caller's key through the
  // notifications table so the same event never pings twice.
  async ping(scope, key, text) {
    if (!this.telegram) return;
    const k = `tg:${key}`.slice(0, 200);
    const seen = await this.first("notifications", `organization = "${esc(scope.organization)}" && dedupe_key = "${esc(k)}"`);
    if (seen) return;
    await this.col("notifications").create({ organization: scope.organization, website: scope.website || "", kind: "telegram", severity: "info", title: text.slice(0, 300), body: "", link: "", dedupe_key: k, occurrences: 1, read_at: this.ts(), created_at: this.ts(), updated_at: this.ts() }, { requestKey: null });
    const w = scope.website ? await this.one("websites", scope.website) : null;
    await this.telegram(`${w ? `[${w.name || w.domain}] ` : ""}${text}${this.appUrl ? `\n${this.appUrl}/today` : ""}`);
  }

  // One image attempt per article version per day (FAL); a failure never blocks the post.
  async ensureImage(run, art) {
    if (!this.images || art.featured_image) return;
    const k = `img:${art.id}:v${art.current_version}:${this.ts().slice(0, 10)}`;
    if (await this.first("notifications", `organization = "${esc(run.organization)}" && dedupe_key = "${esc(k)}"`)) return;
    const r = await this.images(art);
    await this.col("notifications").create({ organization: run.organization, website: run.website, kind: "autopilot_image", severity: r.ok ? "info" : "warning", title: r.ok ? `Image added: ${art.title || ""}`.slice(0, 300) : `Image not generated (${r.code})`, body: "", link: "", dedupe_key: k, occurrences: 1, read_at: this.ts(), created_at: this.ts(), updated_at: this.ts() }, { requestKey: null });
    if (!r.ok) return;
    const fresh = await this.one("articles", art.id);
    // Only before approval and only if still the same version: never alters approved content.
    if (!fresh || fresh.status !== "awaiting_approval" || Number(fresh.current_version) !== Number(art.current_version) || fresh.featured_image) return;
    await this.col("articles").update(art.id, { featured_image: r.url, updated_at: this.ts() }, { requestKey: null });
    art.featured_image = r.url;
  }

  async task(scope, { kind, title, body = "", link = "", evidence = {}, dedup_key, run = "", action = "", remindDays = 0, notify = true, severity = "warning" }) {
    const existing = await this.first("autopilot_tasks", `website = "${esc(scope.website)}" && dedup_key = "${esc(dedup_key)}"`);
    if (existing) {
      if (existing.status === "open") await this.col("autopilot_tasks").update(existing.id, { evidence, updated_at: this.ts() }, { requestKey: null });
      return existing;
    }
    const t = await this.col("autopilot_tasks").create({ organization: scope.organization, client: scope.client, website: scope.website, run, action, kind, title: title.slice(0, 300), body: body.slice(0, 2000), link, evidence, status: "open", dedup_key, remind_at: remindDays ? iso(this.now() + remindDays * DAY) : "", reminders_sent: 0, created_at: this.ts(), updated_at: this.ts() }, { requestKey: null });
    if (notify) await this.notify(scope, { kind: `autopilot_${kind}`, severity, title, body, link, dedupe_key: `autopilot:${dedup_key}` });
    return t;
  }

  async closeTasks(websiteId, filterExtra, reason) {
    const open = await this.all("autopilot_tasks", `website = "${esc(websiteId)}" && status = "open" && ${filterExtra}`);
    for (const t of open) await this.col("autopilot_tasks").update(t.id, { status: "done", resolved_at: this.ts(), body: `${t.body}\n\nResolved: ${reason}`.slice(0, 2000), updated_at: this.ts() }, { requestKey: null });
  }

  // ------------------------------------------------------------ policy / gates
  policyView(p) {
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (p && p[k] !== undefined && p[k] !== null && p[k] !== "") out[k] = p[k];
    out.allowed_actions = Array.isArray(out.allowed_actions) ? out.allowed_actions : DEFAULTS.allowed_actions;
    out.allowed_environments = Array.isArray(out.allowed_environments) ? out.allowed_environments : ["staging"];
    out.id = p?.id || "";
    out.version = Number(p?.version || 0);
    out.publish_after_approval_since = p?.publish_after_approval_since || "";
    out.require_human_publish_approval = true;
    out.pause_on_high_risk = true;
    return out;
  }

  async orgPaused(orgId) {
    const c = await this.first("autopilot_controls", `organization = "${esc(orgId)}"`);
    return Boolean(c?.paused);
  }

  // Live check before any new action: kill switch, website pause, OFF.
  async liveGate(run) {
    if (await this.orgPaused(run.organization)) return { stop: true, code: "AUTOPILOT_PAUSED", reason: "Organization kill switch is on." };
    const p = await this.first("autopilot_policies", `website = "${esc(run.website)}"`);
    if (!p && run.dry_run) return { stop: false, policy: null };
    if (!p) return { stop: true, code: "POLICY", reason: "No policy." };
    if (p.paused) return { stop: true, code: "AUTOPILOT_PAUSED", reason: p.paused_reason || "Autopilot paused for this website." };
    if (!run.dry_run && (!p.enabled || p.mode === "OFF")) return { stop: true, code: "AUTOPILOT_OFF", reason: "Autopilot was disabled." };
    return { stop: false, policy: p };
  }

  // ------------------------------------------------------------ context
  async usage(websiteId) {
    const now = this.now();
    const dayStart = pbDate(now - (now % DAY));
    const weekStart = pbDate(now - 7 * DAY);
    const monthStart = pbDate(now - 30 * DAY);
    const executed = `status != "skipped" && status != "cancelled" && status != "blocked" && status != "planned" && action_type != "NOTIFY_HUMAN" && action_type != "WAIT"`;
    const acts = await this.all("autopilot_actions", `website = "${esc(websiteId)}" && created_at >= "${weekStart}" && ${executed}`, { fields: "action_type,created_at" });
    const today = acts.filter((a) => String(a.created_at).replace("T", " ") >= dayStart);
    const count = (list, t) => list.filter((a) => t.includes(a.action_type)).length;
    const ai = await this.all("ai_usage", `website = "${esc(websiteId)}" && timestamp >= "${monthStart}"`, { fields: "input_tokens,output_tokens,estimated_cost,cost_status,timestamp" });
    const aiToday = ai.filter((r) => String(r.timestamp).replace("T", " ") >= dayStart);
    const cost = (rows) => {
      const known = rows.filter((r) => r.cost_status === "calculated");
      const unknown = rows.length - known.length;
      return { known: known.length ? known.reduce((s, r) => s + (Number(r.estimated_cost) || 0), 0) : (unknown ? null : 0), unknown_calls: unknown };
    };
    return {
      actions_today: today.length,
      content_today: count(today, ["GENERATE_CONTENT"]),
      content_week: count(acts, ["GENERATE_CONTENT"]),
      publications_week: count(acts, ["PUBLISH", "UPDATE_PUBLICATION", "AUTO_PUBLISH"]),
      strategy_week: count(acts, ["STRATEGY_REFRESH"]),
      crawls_week: count(acts, ["CRAWL"]),
      ai_calls_today: aiToday.length,
      ai_tokens_today: aiToday.reduce((s, r) => s + (r.input_tokens || 0) + (r.output_tokens || 0), 0),
      ai_cost_today: cost(aiToday),
      ai_cost_month: cost(ai),
    };
  }

  // Per content job AI estimate from real history of this organization; null = unknown.
  async estimates(orgId) {
    const jobs = await this.col("content_jobs").getList(1, 20, { filter: `organization = "${esc(orgId)}" && status = "completed" && mode = "generate"`, sort: "-created_at", fields: "id", requestKey: null });
    if (!jobs.items.length) return { content_job: { calls: null, tokens: null, cost: null, basis: "no history" } };
    const ids = jobs.items.map((j) => `content_job = "${j.id}"`).join(" || ");
    const rows = await this.all("ai_usage", `(${ids})`, { fields: "content_job,input_tokens,output_tokens,estimated_cost,cost_status" });
    const n = jobs.items.length;
    const calls = Math.ceil(rows.length / n);
    const tokens = Math.ceil(rows.reduce((s, r) => s + (r.input_tokens || 0) + (r.output_tokens || 0), 0) / n);
    const priced = rows.length && rows.every((r) => r.cost_status === "calculated");
    return { content_job: { calls, tokens, cost: priced ? rows.reduce((s, r) => s + (Number(r.estimated_cost) || 0), 0) / n : null, basis: `average of ${n} completed generation job(s)` } };
  }

  async health() {
    const cutoff = pbDate(this.now() - this.staleQueueMs);
    const stalled = async (col) => (await this.count(col, `status = "queued" && created_at < "${cutoff}"`)) > 0;
    const [crawler, strategy, content, publisher] = await Promise.all([stalled("crawl_jobs"), stalled("strategy_jobs"), stalled("content_jobs"), stalled("publish_jobs")]);
    return { crawler: !crawler, strategy: !strategy, content: !content, publisher: !publisher };
  }

  async gscState(website) {
    const prop = await this.first("gsc_properties", `website = "${esc(website.id)}" && selected = true`);
    if (!prop) return { state: "not_connected" };
    const conn = await this.one("gsc_connections", prop.connection);
    if (!conn || conn.status !== "connected" || prop.status === "access_lost") return { state: "connection_lost", property: prop.id, connection: prop.connection, connection_status: conn?.status || "missing" };
    const rows = await this.count("gsc_site_daily", `website = "${esc(website.id)}" && impressions > 0`);
    return { state: rows > 0 ? "has_data" : "no_data", property: prop.id, site_url: prop.site_url, latest_final_date: prop.latest_final_date || null, rows };
  }

  async loadContext(run, policy) {
    const w = await this.one("websites", run.website);
    if (!w || w.organization !== run.organization || w.client !== run.client) throw Object.assign(new Error("Run tenant mismatch"), { code: "TENANT_MISMATCH" });
    const wid = esc(w.id);
    const lastCrawl = await this.first("crawl_jobs", `website = "${wid}" && (status = "completed" || status = "completed_with_errors")`, { sort: "-completed_at" });
    const activeCrawl = await this.first("crawl_jobs", `website = "${wid}" && (status = "queued" || status = "running")`);
    const lastVersion = await this.first("strategy_versions", `website = "${wid}"`, { sort: "-version" });
    const activeStrategy = await this.first("strategy_jobs", `website = "${wid}" && (status = "queued" || status = "running")`);
    const material = lastCrawl ? await this.count("website_changes", `crawl_job = "${lastCrawl.id}"`) : 0;

    const issues = await this.all("seo_issues", `website = "${wid}" && status = "open" && (severity = "critical" || severity = "high")`, { fields: "id,issue_type,severity,title,page" });
    const groups = new Map();
    for (const i of issues) {
      const g = groups.get(i.issue_type) || { issue_type: i.issue_type, severity: i.severity, count: 0, title: i.title, sample_issue: i.id, sample_pages: [] };
      g.count++;
      if (g.sample_pages.length < 5 && i.page) g.sample_pages.push(i.page);
      if (i.severity === "critical") g.severity = "critical";
      groups.set(i.issue_type, g);
    }

    const oppRows = await this.all("content_opportunities", `website = "${wid}" && status = "approved"`, { expand: "keyword", sort: "-created_at" });
    // Simple mode: also consider PROPOSED topics of the latest strategy version
    // (never skipped/reviewed ones). Approved topics always come first.
    if (policy.auto_pick_opportunities && lastVersion) {
      const proposed = await this.all("content_opportunities", `website = "${wid}" && status = "proposed" && strategy_version = "${esc(lastVersion.id)}" && existing_page = ""`, { expand: "keyword", sort: "-created_at" });
      const rank = { high: 0, medium: 1, low: 2 };
      proposed.sort((a, b) => (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3));
      oppRows.push(...proposed);
    }
    const seenKw = new Set();
    const opportunities = [];
    for (const o of oppRows) {
      const kw = o.expand?.keyword;
      const text = (kw?.keyword || o.title_suggestion || "").toLowerCase().trim();
      if (text && seenKw.has(text)) continue; // same intent approved in several strategy versions → newest wins
      seenKw.add(text);
      opportunities.push({ id: o.id, strategy_version: o.strategy_version, opportunity_type: o.opportunity_type, recommended_page_type: o.recommended_page_type, existing_page: o.existing_page || "", recommended_url: o.recommended_url || "", title_suggestion: o.title_suggestion || "", priority: o.priority, status: o.status, confidence: o.confidence, keyword_text: kw?.keyword || "", intent: kw?.intent || "", target_location: kw?.target_location || "" });
    }
    const cannibal = lastVersion ? await this.all("cannibalization_issues", `website = "${wid}" && strategy_version = "${lastVersion.id}" && (status = "open" || status = "reviewed")`, { fields: "id,keyword_group" }) : [];
    const facts = await this.all("business_facts", `website = "${wid}" && (verified = true || verification_state = "verified" || verification_state = "user_confirmed")`, { fields: "fact_type" });

    const managedActs = await this.all("autopilot_actions", `website = "${wid}" && article != ""`, { fields: "article,action_type,status,created_at" });
    const managed = new Set(managedActs.filter((a) => a.action_type === "GENERATE_CONTENT").map((a) => a.article));
    const revisions = {};
    for (const a of managedActs) if (a.action_type === "REQUEST_REVISION" && !["skipped", "cancelled", "blocked", "planned"].includes(a.status)) revisions[a.article] = (revisions[a.article] || 0) + 1;
    const arts = await this.all("articles", `website = "${wid}"`, { fields: "id,status,title,primary_keyword,recommended_url,content_opportunity,current_version,qa_status,qa_score,flags,risk_categories,fact_check_status,high_risk,approved_by,approved_at,approved_version,approved_hash,updated_at,expand.approved_by.name", expand: "approved_by" });
    const pubs = await this.all("article_publications", `website = "${wid}"`, { fields: "id,article,status,public_url,article_version,published_at,updated,updated_at" });
    const pubBy = Object.fromEntries(pubs.map((p) => [p.article, p]));
    const outcomes = await this.all("autopilot_outcomes", `website = "${wid}"`, { fields: "article,changed_at", sort: "-changed_at" });
    const lastChange = {};
    for (const o of outcomes) if (!lastChange[o.article]) lastChange[o.article] = o.changed_at;
    const since = policy.publish_after_approval_since ? Date.parse(String(policy.publish_after_approval_since).replace(" ", "T")) : null;
    const articles = [];
    for (const a of arts) {
      let lastJob = null;
      if (a.status === "publish_failed") lastJob = await this.first("publish_jobs", `article = "${a.id}" && status = "failed"`, { sort: "-created_at", fields: "id,error_code" });
      const approvedAt = a.approved_at ? Date.parse(String(a.approved_at).replace(" ", "T")) : null;
      articles.push({
        ...a, managed: managed.has(a.id), approved_by_name: a.expand?.approved_by?.name || "",
        // Auto-publish only considers approvals made while the policy allowed it.
        approval_after_policy: Boolean(since !== null && approvedAt !== null && approvedAt >= since),
        publication: pubBy[a.id] || null, last_changed_at: lastChange[a.id] || pubBy[a.id]?.published_at || "",
        last_publish_job: lastJob?.id || "", last_publish_error: lastJob?.error_code || "",
      });
    }
    const gsc = await this.gscState(w);
    const analytics = gsc.state === "has_data" ? await this.all("analytics_opportunities", `website = "${wid}" && (status = "new" || status = "reviewed" || status = "accepted")`) : [];
    const circuits = {};
    for (const c of await this.all("autopilot_circuits", `website = "${wid}"`)) circuits[c.action_type] = c.state;
    return {
      now: this.now(), website: w, policy,
      crawl: { last_id: lastCrawl?.id || "", last_completed_at: lastCrawl?.completed_at || lastCrawl?.created_at || "", active: Boolean(activeCrawl), material_changes: material },
      strategy: { last_version_id: lastVersion?.id || "", last_generated_at: lastVersion?.generated_at || "", active: Boolean(activeStrategy) },
      technical: [...groups.values()], opportunities, cannibalization: cannibal.map((c) => ({ id: c.id, keyword_group: c.keyword_group, keyword_norm: normalize(c.keyword_group) })),
      facts: { verified_types: new Set(facts.map((f) => f.fact_type)) }, articles: articles.map((a) => ({ ...a, eligible_for_auto_publish: a.managed && a.approval_after_policy })), revisionsByArticle: revisions,
      gsc, analytics, circuits, usage: await this.usage(w.id), estimates: await this.estimates(w.organization), health: await this.health(),
    };
  }

  // ------------------------------------------------------------ signals
  async upsertSignals(run, derived) {
    const now = this.now();
    const existing = await this.all("autopilot_signals", `website = "${esc(run.website)}"`);
    const byKey = new Map(existing.map((s) => [s.dedup_key, s]));
    const active = [];
    const seen = new Set();
    let created = 0, updated = 0;
    for (const d of derived) {
      seen.add(d.dedup_key);
      const cur = byKey.get(d.dedup_key);
      const expires = d.source === "search_console" ? iso(now + 14 * DAY) : "";
      if (!cur) {
        const rec = await this.col("autopilot_signals").create({ organization: run.organization, client: run.client, website: run.website, source: d.source, source_record: d.source_record || "", signal_type: d.signal_type, evidence: d.evidence, strength: d.strength, detected_at: iso(now), last_seen_at: iso(now), seen_count: 1, expires_at: expires, status: "active", dedup_key: d.dedup_key, last_run: run.id, created_at: iso(now), updated_at: iso(now) }, { requestKey: null });
        created++;
        active.push({ ...d, id: rec.id });
        continue;
      }
      const patch = { evidence: d.evidence, strength: d.strength, last_seen_at: iso(now), seen_count: Number(cur.seen_count || 0) + 1, last_run: run.id, updated_at: iso(now) };
      if (expires) patch.expires_at = expires;
      let status = cur.status;
      if (status === "snoozed" && cur.snoozed_until && Date.parse(String(cur.snoozed_until).replace(" ", "T")) <= now) { status = "active"; patch.snoozed_until = ""; patch.status_reason = "Snooze ended"; }
      if (status === "resolved" || status === "expired") { status = "active"; patch.status_reason = "Detected again"; }
      patch.status = status;
      await this.col("autopilot_signals").update(cur.id, patch, { requestKey: null });
      updated++;
      if (status === "active") active.push({ ...d, id: cur.id });
    }
    // Not seen any more → resolved; past expiry → expired. Ignored/snoozed stay as the human set them.
    for (const s of existing) {
      if (seen.has(s.dedup_key) || s.status !== "active") continue;
      const expired = s.expires_at && Date.parse(String(s.expires_at).replace(" ", "T")) <= now;
      await this.col("autopilot_signals").update(s.id, { status: expired ? "expired" : "resolved", status_reason: expired ? "Expired" : "Condition no longer present", updated_at: iso(now) }, { requestKey: null });
    }
    return { active, created, updated, total: derived.length };
  }

  // ------------------------------------------------------------ run state
  async transition(kind, id, to, patch = {}) {
    return this.internal("transition", { kind, id, to, patch });
  }

  async lease(run, release = false) {
    return this.internal("lease", { runId: run.id, owner: this.workerId, seconds: this.leaseSeconds, release });
  }

  // ------------------------------------------------------------ actions
  async reconcileAction(run, a) {
    const done = async (status, result = {}, err = null) => {
      const patch = { result: { ...(a.result || {}), ...result }, completed_at: this.ts() };
      if (err) Object.assign(patch, { error_code: err.code || "", error_message: String(err.message || "").slice(0, 1000), error_class: classifyError(err.code) });
      await this.transition("action", a.id, status, patch);
      await this.event(run, `action_${status}`, `${a.action_type} ${status.replace(/_/g, " ")}${err ? `: ${err.code}` : ""}`, result, a.id);
      await this.audit(run, status === "failed" ? "AUTOPILOT_ACTION_FAILED" : "AUTOPILOT_ACTION_COMPLETED", "autopilot_action", a.id, { action_type: a.action_type, status, run: run.id, job: a.job_id, error_code: err?.code || null });
      await this.circuit(run, a.action_type, status === "failed" ? classifyError(err?.code) : null, err?.code);
      return status;
    };
    if (a.job_type === "crawl_job" || a.job_type === "strategy_job") {
      const j = await this.one(a.job_type === "crawl_job" ? "crawl_jobs" : "strategy_jobs", a.job_id);
      if (!j) return done("failed", {}, { code: "JOB_MISSING", message: "Job not found" });
      if (j.status === "completed" || j.status === "completed_with_errors") return done(j.status === "completed" ? "completed" : "completed_with_warnings", { job_status: j.status });
      if (j.status === "failed" || j.status === "cancelled") return done(j.status === "cancelled" ? "cancelled" : "failed", { job_status: j.status }, { code: j.status === "cancelled" ? "CANCELLED" : "JOB_FAILED", message: j.error_message || j.error || "" });
      return "running";
    }
    if (a.action_type === "GENERATE_CONTENT" || a.action_type === "REQUEST_REVISION" || a.action_type === "RECHECK_CONTENT") {
      const art = await this.one("articles", a.article);
      const job = await this.one("content_jobs", a.job_id);
      if (!art) return done("failed", {}, { code: "ARTICLE_MISSING", message: "Article not found" });
      if (job && (job.status === "queued" || job.status === "running")) return "running";
      if (job && job.status === "cancelled") return done("cancelled", { article_status: art.status }, { code: "CANCELLED", message: "Content job cancelled by a human" });
      if (job && job.status === "failed") return done("failed", { article_status: art.status, job_status: "failed" }, { code: job.error_code || "CONTENT_JOB_FAILED", message: String(job.error || "").replace(/<[^>]+>/g, " ").slice(0, 500) });
      // Operational success criterion: the article reached awaiting_approval.
      if (art.status === "awaiting_approval" || art.status === "approved" || PUBLISHED.includes(art.status)) return done("completed", { article_status: art.status, version: art.current_version, qa_status: art.qa_status, fact_check_status: art.fact_check_status, high_risk: art.high_risk });
      if (art.status === "needs_revision" || art.status === "rejected") return done("completed_with_warnings", { article_status: art.status, version: art.current_version, qa_status: art.qa_status, fact_check_status: art.fact_check_status });
      if (art.status === "failed") return done("failed", { article_status: art.status }, { code: "CONTENT_FAILED", message: "Phase 4 pipeline failed" });
      return "running";
    }
    if (["PUBLISH", "UPDATE_PUBLICATION", "VERIFY_PUBLICATION", "AUTO_PUBLISH"].includes(a.action_type)) {
      const j = await this.one("publish_jobs", a.job_id);
      if (!j) return done("failed", {}, { code: "JOB_MISSING", message: "Publish job not found" });
      if (["queued", "validating", "publishing", "verifying", "unpublishing"].includes(j.status)) return "running";
      if (j.status === "published" || j.status === "completed") {
        const pub = j.publication ? await this.one("article_publications", j.publication) : await this.first("article_publications", `article = "${esc(a.article)}"`);
        const r = await done("completed", { publish_status: j.status, public_url: j.public_url || pub?.public_url || "", article_version: j.article_version, verified_at: pub?.last_verified_at || "", environment: a.result?.environment || "" });
        if (a.action_type !== "VERIFY_PUBLICATION") {
          await this.recordOutcome(run, a, j, pub);
          const art = await this.one("articles", a.article).catch(() => null);
          await this.ping(run, `pub:${a.id}`, `✅ ${a.action_type === "AUTO_PUBLISH" ? "Auto-published" : "Published"}: "${art?.title || "post"}"${j.public_url || pub?.public_url ? `\n${j.public_url || pub?.public_url}` : ""}`);
        }
        await this.closeTasks(run.website, `kind = "article_approval" && dedup_key ~ "${esc(a.article)}"`, "published");
        return r;
      }
      if (j.status === "verification_required") return done("completed_with_warnings", { publish_status: j.status, public_url: j.public_url || "" }, { code: j.error_code || "VERIFICATION_FAILED", message: j.error_message || "" });
      if (j.status === "cancelled") return done("cancelled", { publish_status: j.status }, { code: "CANCELLED", message: "Publish job cancelled" });
      return done("failed", { publish_status: j.status }, { code: j.error_code || "PUBLISH_FAILED", message: j.error_message || "" });
    }
    return a.status;
  }

  async recordOutcome(run, a, job, pub) {
    const exists = await this.first("autopilot_outcomes", `action = "${a.id}"`);
    if (exists) return;
    await this.col("autopilot_outcomes").create({ organization: run.organization, client: run.client, website: run.website, action: a.id, article: a.article, publication: pub?.id || "", article_version: Number(job.article_version || 0), public_url: job.public_url || pub?.public_url || "", change_type: a.action_type === "UPDATE_PUBLICATION" ? "update" : "publish", changed_at: job.completed_at || this.ts(), observations: [], status: "waiting_for_data", created_at: this.ts(), updated_at: this.ts() }, { requestKey: null });
  }

  // Observation windows: REAL Search Console aggregates only; NO_DATA otherwise.
  // Never a causal claim ("performance after the change", not "caused by").
  async observeOutcomes(run, gsc) {
    const list = await this.all("autopilot_outcomes", `website = "${esc(run.website)}" && status != "observed"`);
    for (const o of list) {
      const changed = Date.parse(String(o.changed_at).replace(" ", "T"));
      const obs = [];
      for (const days of [7, 28, 90]) {
        const end = changed + days * DAY;
        if (end > this.now()) break;
        if (gsc.state !== "has_data") { obs.push({ window_days: days, state: "NO_DATA" }); continue; }
        const rows = await this.all("gsc_page_daily", `website = "${esc(run.website)}" && page = "${esc(o.public_url)}" && date >= "${iso(changed).slice(0, 10)}" && date <= "${iso(end).slice(0, 10)}"`, { fields: "clicks,impressions" });
        obs.push(rows.length ? { window_days: days, state: "OBSERVED", clicks: rows.reduce((s, r) => s + (r.clicks || 0), 0), impressions: rows.reduce((s, r) => s + (r.impressions || 0), 0), days_with_data: rows.length, note: "Observed after the change; not evidence of causation." } : { window_days: days, state: "NO_DATA" });
      }
      const status = obs.length === 3 ? "observed" : obs.some((x) => x.state === "OBSERVED") ? "observing" : "waiting_for_data";
      await this.col("autopilot_outcomes").update(o.id, { observations: obs, status, updated_at: this.ts() }, { requestKey: null });
    }
  }

  async circuit(run, actionType, errorClass, code) {
    const group = circuitGroup(actionType);
    let c = await this.first("autopilot_circuits", `website = "${esc(run.website)}" && action_type = "${group}"`);
    if (!errorClass) {
      if (c && (c.consecutive_failures || c.state === "open") && c.state !== "open") await this.col("autopilot_circuits").update(c.id, { consecutive_failures: 0, updated_at: this.ts() }, { requestKey: null });
      return;
    }
    if (errorClass === "POLICY") return; // human/policy stops are not failures of the integration
    if (!c) c = await this.col("autopilot_circuits").create({ organization: run.organization, client: run.client, website: run.website, action_type: group, state: "closed", consecutive_failures: 0, created_at: this.ts(), updated_at: this.ts() }, { requestKey: null });
    const sameClass = !c.last_error_class || c.last_error_class === errorClass;
    const n = sameClass ? Number(c.consecutive_failures || 0) + 1 : 1;
    const patch = { consecutive_failures: n, last_error_class: errorClass, last_error_code: code || "", updated_at: this.ts() };
    if (n >= CIRCUIT_THRESHOLD && c.state !== "open") {
      patch.state = "open";
      patch.opened_at = this.ts();
      await this.col("autopilot_circuits").update(c.id, patch, { requestKey: null });
      await this.audit(run, "AUTOPILOT_CIRCUIT_OPENED", "autopilot_circuit", c.id, { action_type: group, error_class: errorClass, error_code: code, failures: n });
      await this.task(run, { kind: "circuit_open", title: `Autopilot paused ${group} after ${n} ${errorClass} failures`, body: `Last error: ${code || errorClass}. Fix the cause, then reset the circuit in Autopilot.`, dedup_key: `circuit:${group}:${c.id}:${this.ts().slice(0, 10)}`, severity: "critical", link: `/websites/${run.website}/autopilot` });
      return;
    }
    await this.col("autopilot_circuits").update(c.id, patch, { requestKey: null });
  }

  // Create (idempotently) the action for a planned decision.
  async materialize(run, decisionRec, d, snapshot, { observe }) {
    const pa = d.planned_action;
    const key = pa.idempotency_key;
    const prior = await this.all("autopilot_actions", `idempotency_key = "${esc(key)}"`, { sort: "-created_at" });
    const live = prior.find((x) => !["failed", "cancelled", "skipped"].includes(x.status));
    if (live) return { action: live, reused: true };
    const recommended = observe && prior.find((x) => x.status === "skipped" && x.error_code === "OBSERVE_MODE");
    if (recommended) return { action: recommended, reused: true };
    const cancelled = prior.find((x) => x.status === "cancelled");
    const failures = prior.filter((x) => x.status === "failed");
    let block = d.block_code ? { code: d.block_code, message: d.reason } : null;
    if (!block && cancelled) block = { code: "CANCELLED_BY_USER", message: "A human cancelled this action before; Autopilot does not recreate it automatically." };
    if (!block && failures.length) {
      const last = failures[0];
      if (!retryable(last.error_class)) block = { code: "NOT_RETRYABLE", message: `Previous attempt failed with ${last.error_class} (${last.error_code}); no automatic retry.` };
      else if (failures.length >= MAX_TRANSIENT_ATTEMPTS) block = { code: "RETRY_LIMIT", message: `${failures.length} transient failures; retry limit reached.` };
    }
    const status = block ? "blocked" : observe ? "skipped" : "planned";
    const rec = {
      organization: run.organization, client: run.client, website: run.website, run: run.id, decision: decisionRec.id,
      action_type: pa.action_type, target_type: pa.target_type, target_id: pa.target_id, article: pa.target_type === "article" ? pa.target_id : "",
      status, requires_approval: Boolean(d.requires_approval), idempotency_key: key, attempt: failures.length + 1, max_attempts: MAX_TRANSIENT_ATTEMPTS,
      policy_snapshot: snapshot, result: { planned: pa, observe_only: Boolean(observe) }, error_class: block ? "POLICY" : "", error_code: block?.code || (observe ? "OBSERVE_MODE" : ""), error_message: block?.message || (observe ? "OBSERVE mode records recommendations only." : ""),
      created_at: this.ts(), updated_at: this.ts(),
    };
    try {
      const a = await this.col("autopilot_actions").create(rec, { requestKey: null });
      if (status !== "skipped") await this.audit(run, "AUTOPILOT_ACTION_PLANNED", "autopilot_action", a.id, { action_type: a.action_type, target: `${pa.target_type}:${pa.target_id}`, status, block: block?.code || null, decision: decisionRec.id });
      await this.event(run, block ? "action_blocked" : observe ? "action_recommended" : "action_planned", `${pa.action_type} ${block ? `blocked (${block.code})` : observe ? "recommended (OBSERVE)" : "planned"} — ${d.reason}`.slice(0, 1000), { decision: d.decision_type, rule: d.rule }, a.id);
      return { action: a, reused: false };
    } catch (e) {
      // Unique idempotency index: a concurrent writer won — reuse its action.
      const again = await this.first("autopilot_actions", `idempotency_key = "${esc(key)}" && status != "failed" && status != "cancelled" && status != "skipped"`);
      if (again) return { action: again, reused: true };
      throw e;
    }
  }

  async executeAction(run, a) {
    const gateNow = await this.liveGate(run);
    if (gateNow.stop) {
      await this.transition("action", a.id, "blocked", { error_class: "POLICY", error_code: gateNow.code, error_message: gateNow.reason });
      return { stopped: true, code: gateNow.code };
    }
    if (a.action_type === "NOTIFY_HUMAN") {
      const t = a.result?.planned?.task || {};
      await this.task(run, { kind: t.kind || "human_review", title: t.title || "Autopilot needs your attention", body: a.error_message || a.result?.reason || "", evidence: a.result?.planned || {}, dedup_key: a.idempotency_key, run: run.id, action: a.id, link: t.link || (a.article ? `/articles/${a.article}` : `/websites/${run.website}/autopilot`), severity: t.kind === "integration_reconnect" || t.kind === "publishing_integration" ? "critical" : "warning" });
      await this.transition("action", a.id, "completed", { completed_at: this.ts(), started_at: this.ts() });
      return { ok: true };
    }
    await this.transition("action", a.id, "running", { started_at: this.ts() });
    await this.audit(run, "AUTOPILOT_ACTION_STARTED", "autopilot_action", a.id, { action_type: a.action_type, target: `${a.target_type}:${a.target_id}` });
    try {
      const r = await this.execute({ actionId: a.id, expectedHash: a.result?.planned?.expected_hash || "", instruction: a.result?.planned?.instruction || "" });
      const patch = { job_type: r.job_type || "", job_id: r.job_id || "", result: { ...(a.result || {}), ...r } };
      if (r.article_id) patch.article = r.article_id;
      const updated = await this.transition("action", a.id, "running", patch);
      await this.event(run, "job_queued", `${a.action_type}: ${r.job_type} ${r.job_id}${r.created === false ? " (existing job reused)" : ""}`, r, a.id);
      return { ok: true, action: updated };
    } catch (e) {
      const code = e?.response?.code || e?.data?.code || e?.code || "EXECUTE_FAILED";
      const status = e?.status || 0;
      const cls = classifyError(code, status);
      const message = String(e?.response?.message || e?.message || "").slice(0, 1000);
      await this.transition("action", a.id, "failed", { error_class: cls, error_code: code, error_message: message, completed_at: this.ts() });
      await this.event(run, "action_failed", `${a.action_type} failed: ${code} (${cls})${retryable(cls) ? " — may retry on a later run" : " — no automatic retry"}`, { code, class: cls }, a.id);
      await this.audit(run, "AUTOPILOT_ACTION_FAILED", "autopilot_action", a.id, { action_type: a.action_type, error_code: code, error_class: cls });
      await this.circuit(run, a.action_type, cls, code);
      if (code === "SLUG_CONFLICT") await this.task(run, { kind: "slug_conflict", title: "Resolve slug conflict before publishing", body: message, dedup_key: `slug:${a.target_id}`, link: `/articles/${a.target_id}` });
      if (code === "HIGH_RISK_REVIEW_REQUIRED") await this.task(run, { kind: "high_risk_review", title: "High-risk article — publish manually after review", body: message, dedup_key: `highrisk:${a.target_id}`, link: `/articles/${a.target_id}` });
      if (cls === "CONFIGURATION" && a.action_type.includes("PUBLISH")) await this.ping(run, `integ:${run.website}:${code}:${this.ts().slice(0, 10)}`, `⚠️ Could not publish — website connection problem (${code}).`);
      if (cls === "CONFIGURATION" && a.action_type.includes("PUBLISH")) await this.task(run, { kind: "publishing_integration", title: "Fix the publishing integration", body: message, dedup_key: `integration:${run.website}:${code}`, severity: "critical", link: `/websites/${run.website}/publishing` });
      return { ok: false, code, cls };
    }
  }

  // ------------------------------------------------------------ run cycle
  async processRun(runId) {
    let run = await this.one("autopilot_runs", runId);
    if (!run) return null;
    const lease = await this.lease(run);
    if (!lease.acquired) return { skipped: "leased", owner: lease.owner };
    try {
      return await this.cycle(run);
    } catch (e) {
      const code = e?.response?.code || e?.code || "RUN_FAILED";
      this.logger.error(`[autopilot] run=${runId} failed ${code} ${String(e?.message || e).slice(0, 300)}`);
      run = await this.one("autopilot_runs", runId);
      if (run && !["completed", "completed_with_warnings", "failed", "cancelled"].includes(run.status)) {
        await this.transition("run", run.id, "failed", { error_code: String(code).slice(0, 80), error_message: String(e?.message || e).slice(0, 1000), completed_at: this.ts(), current_step: "failed" }).catch(() => {});
        await this.event(run, "run_failed", `Run failed: ${code}`, { class: classifyError(code, e?.status) }).catch(() => {});
        await this.audit(run, "AUTOPILOT_RUN_COMPLETED", "autopilot_run", run.id, { status: "failed", error_code: code }).catch(() => {});
      }
      return { failed: code };
    } finally {
      await this.lease(run, true).catch(() => {});
    }
  }

  async cycle(run) {
    const first = run.status === "queued";
    const live = await this.liveGate(run);
    if (live.stop) {
      const cancel = first || live.code === "AUTOPILOT_OFF" || live.code === "POLICY";
      if (!["completed", "completed_with_warnings", "failed", "cancelled"].includes(run.status) && !(run.status === "paused" && !cancel)) await this.transition("run", run.id, cancel ? "cancelled" : "paused", { reason: live.reason, error_code: live.code, current_step: "stopped", completed_at: cancel ? this.ts() : "" });
      await this.event(run, "run_stopped", `Stopped before acting: ${live.reason}`, { code: live.code });
      return { stopped: live.code };
    }
    const policyRec = live.policy;
    // Snapshot: taken at run start and reused by every continuation cycle.
    const snapshot = run.policy_snapshot && run.policy_snapshot.version !== undefined ? run.policy_snapshot : this.policyView(policyRec);
    const mode = run.dry_run ? "DRY_RUN" : snapshot.mode;
    const cycles = Number(run.result?.cycles || 0) + 1;
    if (cycles > MAX_CYCLES_PER_RUN) {
      await this.transition("run", run.id, "completed_with_warnings", { reason: `Cycle limit ${MAX_CYCLES_PER_RUN} reached; a new run will pick up remaining work.`, completed_at: this.ts() });
      return { status: "completed_with_warnings" };
    }
    if (first) {
      await this.transition("run", run.id, "collecting_signals", { started_at: this.ts(), policy_snapshot: snapshot, mode, current_step: "collecting signals" });
      await this.event(run, "run_started", `${run.dry_run ? "Dry run" : run.trigger === "scheduled" ? "Scheduled run" : run.trigger === "manual" ? "Manual run" : `Run triggered by ${run.trigger}`} (${mode}, policy v${snapshot.version})`, { trigger: run.trigger, trigger_ref: run.trigger_ref || "" });
      if (!run.dry_run) await this.audit(run, "AUTOPILOT_RUN_STARTED", "autopilot_run", run.id, { trigger: run.trigger, mode, policy_version: snapshot.version });
    } else {
      await this.transition("run", run.id, "evaluating", { current_step: "re-evaluating after event" });
      await this.event(run, "run_resumed", `Resumed after ${run.result?.resume_trigger || "event"}`, { trigger: run.result?.resume_trigger || "" });
    }

    // Reconcile in-flight actions first (event continuation).
    const inflight = await this.all("autopilot_actions", `run = "${run.id}" && (status = "queued" || status = "running")`);
    for (const a of inflight) await this.reconcileAction(run, a);

    await this.approvalTasks(run, snapshot);
    const ctx = await this.loadContext(run, snapshot);
    const derived = deriveSignals(ctx);
    const sig = await this.upsertSignals(run, derived);
    if (first) await this.transition("run", run.id, "evaluating", { current_step: "evaluating", signal_count: sig.active.length });
    else await this.col("autopilot_runs").update(run.id, { signal_count: sig.active.length, updated_at: this.ts() }, { requestKey: null });

    // Eligibility for auto-publish needs a managed article approved after the policy allowed it.
    const decisions = decide(sig.active, ctx);
    await this.transition("run", run.id, "planning", { current_step: "planning" });

    const prior = await this.all("autopilot_decisions", `run = "${run.id}"`, { fields: "signal,decision_type,rule,block_code" });
    const seenDecision = new Set(prior.map((d) => `${d.signal}|${d.decision_type}|${d.rule}|${d.block_code}`));
    const toExecute = [];
    let recorded = prior.length;
    for (const d of decisions) {
      const k = `${d.signal?.id || ""}|${d.decision_type}|${d.rule}|${d.block_code || ""}`;
      if (seenDecision.has(k) && !d.planned_action) continue; // unchanged informational decision: keep history compact
      let rec = null;
      if (!seenDecision.has(k)) {
        seenDecision.add(k);
        rec = await this.col("autopilot_decisions").create({
          organization: run.organization, client: run.client, website: run.website, run: run.id, signal: d.signal?.id || "", decision_type: d.decision_type, priority: d.priority, score: d.score,
          evidence: { signal_type: d.signal?.signal_type || null, source: d.signal?.source || null, source_record: d.signal?.source_record || null, ...d.evidence }, reason: String(d.reason).slice(0, 2000), rule: d.rule, block_code: d.block_code || "",
          planned_action: d.planned_action || null, explanation: explain(d, run, snapshot).slice(0, 2000), policy_snapshot: { version: snapshot.version, mode: snapshot.mode, publish_after_human_approval: snapshot.publish_after_human_approval, allowed_actions: snapshot.allowed_actions, allowed_environments: snapshot.allowed_environments },
          risk_level: d.risk_level, requires_approval: d.requires_approval, status: run.dry_run ? "dry_run" : d.block_code ? "blocked" : d.planned_action ? "planned" : "proposed", created_at: this.ts(), updated_at: this.ts(),
        }, { requestKey: null });
        recorded++;
      } else {
        rec = await this.first("autopilot_decisions", `run = "${run.id}" && signal = "${esc(d.signal?.id || "")}" && decision_type = "${d.decision_type}" && rule = "${esc(d.rule)}"`);
      }
      if (!d.planned_action || run.dry_run) continue;
      const observe = snapshot.mode !== "SUPERVISED";
      // OBSERVE still raises human tasks (recommendations); it never starts jobs.
      const { action, reused } = await this.materialize(run, rec, d, snapshot, { observe: observe && d.planned_action.action_type !== "NOTIFY_HUMAN" });
      if (!reused && action.status === "planned") toExecute.push(action);
    }

    if (run.dry_run) {
      const summary = summarize(decisions, ctx);
      await this.transition("run", run.id, "completed", { completed_at: this.ts(), decision_count: recorded, action_count: 0, current_step: "dry run complete", result: { cycles, dry_run: summary, jobs_created: 0 }, ai_cost_status: "none", estimated_ai_cost: 0 });
      await this.event(run, "dry_run_completed", `Dry run: generate=${summary.would_generate_content ? "yes" : "no"}, crawl=${summary.would_refresh_crawl ? "yes" : "no"}, strategy=${summary.would_refresh_strategy ? "yes" : "no"}, publish: ${summary.would_publish}`, summary);
      return { status: "completed", dry_run: summary };
    }

    await this.transition("run", run.id, "executing", { current_step: "executing", decision_count: recorded });
    let stopped = null;
    for (const a of toExecute) {
      const r = await this.executeAction(run, a);
      if (r.stopped) { stopped = r.code; break; }
    }
    // Immediate reconciliation (NOTIFY / reused jobs may already be done).
    for (const a of await this.all("autopilot_actions", `run = "${run.id}" && (status = "queued" || status = "running")`)) await this.reconcileAction(run, a);
    await this.observeOutcomes(run, ctx.gsc);
    await this.approvalTasks(run, snapshot);
    if (ctx.usage && decisions.some((d) => d.block_code === "BUDGET_LIMIT")) {
      await this.audit(run, "AUTOPILOT_BUDGET_PAUSED", "autopilot_run", run.id, { blocked: decisions.filter((d) => d.block_code === "BUDGET_LIMIT").map((d) => d.reason) });
      await this.task(run, { kind: "budget_limit", title: "Autopilot budget limit reached", body: decisions.find((d) => d.block_code === "BUDGET_LIMIT").reason, dedup_key: `budget:${this.ts().slice(0, 10)}`, link: `/websites/${run.website}/autopilot` });
    }
    return this.settle(run, { cycles, stopped, gsc: ctx.gsc, snapshot });
  }

  // Human-approval tasks for Autopilot-managed drafts (never auto-approved).
  async approvalTasks(run, snapshot) {
    const acts = await this.all("autopilot_actions", `website = "${esc(run.website)}" && action_type = "GENERATE_CONTENT" && article != ""`, { fields: "article,run" });
    for (const id of new Set(acts.map((a) => a.article))) {
      const art = await this.one("articles", id);
      if (!art) continue;
      const key = `approval:${art.id}:v${art.current_version}`;
      if (art.status === "awaiting_approval") {
        await this.ensureImage(run, art);
        const t = await this.task(run, { kind: "article_approval", title: `Article ready for approval: ${art.title || art.primary_keyword}`, body: `Version ${art.current_version} passed the Phase 4 pipeline (fact check ${art.fact_check_status}, QA ${art.qa_status}${art.high_risk ? ", HIGH RISK" : ""}). Autopilot never approves content.${snapshot.publish_after_human_approval && !art.high_risk ? " After your approval Autopilot will publish this version to the configured staging target." : ""}`, dedup_key: key, run: run.id, link: `/articles/${art.id}`, remindDays: snapshot.approval_reminder_days, severity: "info" });
        // Reminder after N days; stays waiting forever — never auto-approves.
        if (t.status === "open" && t.remind_at && Date.parse(String(t.remind_at).replace(" ", "T")) <= this.now()) {
          await this.notify(run, { kind: "autopilot_article_approval", severity: "info", title: `Reminder: article waiting for approval — ${art.title || art.primary_keyword}`, dedupe_key: `autopilot:${key}`, link: `/articles/${art.id}`, reopen: true });
          await this.col("autopilot_tasks").update(t.id, { reminders_sent: Number(t.reminders_sent || 0) + 1, remind_at: iso(this.now() + snapshot.approval_reminder_days * DAY), updated_at: this.ts() }, { requestKey: null });
        }
        if (!(snapshot.auto_publish_safe && art.qa_status === "PASS" && art.fact_check_status === "passed" && !art.high_risk)) {
          await this.ping(run, `wait:${art.id}:v${art.current_version}`, `👀 Post ready for your OK: "${art.title || art.primary_keyword}"`);
        }
        const first = await this.first("autopilot_run_events", `run = "${run.id}" && kind = "waiting_approval" && action = "${art.id}"`);
        if (!first) {
          await this.event(run, "waiting_approval", `Article v${art.current_version} requires human approval`, { article: art.id, version: art.current_version }, art.id);
          await this.audit(run, "AUTOPILOT_WAITING_APPROVAL", "article", art.id, { version: art.current_version, run: run.id });
        }
      } else {
        await this.closeTasks(run.website, `kind = "article_approval" && dedup_key ~ "approval:${esc(art.id)}"`, art.status);
        const human = art.status === "rejected" ? "rejected" : (art.approved_by && (art.status === "approved" || PUBLISHED.includes(art.status))) ? "approved" : null;
        if (human) {
          const at = human === "approved" ? art.approved_at : art.rejected_at;
          const seen = (await this.all("autopilot_run_events", `website = "${esc(run.website)}" && kind = "human_${human}" && action = "${art.id}"`)).find((e) => e.details?.at === at);
          if (!seen) {
            const who = human === "approved" ? art.approved_by : art.rejected_by;
            const u = who ? await this.one("users", who).catch(() => null) : null;
            await this.event(run, `human_${human}`, `${human === "approved" ? "Approved" : "Rejected"} by ${u?.name || u?.email || who || "a human"}${human === "approved" ? ` (v${art.approved_version})` : ""}`, { article: art.id, user: who, at, version: human === "approved" ? art.approved_version : art.current_version }, art.id);
          }
        }
      }
    }
  }

  async settle(run, { cycles, stopped, gsc, snapshot }) {
    const acts = await this.all("autopilot_actions", `run = "${run.id}"`);
    const inflight = acts.filter((a) => a.status === "queued" || a.status === "running");
    const managed = [...new Set(acts.filter((a) => a.action_type === "GENERATE_CONTENT" && a.article).map((a) => a.article))];
    let waiting = false;
    for (const id of managed) {
      const art = await this.one("articles", id);
      if (art && (art.status === "awaiting_approval" || (art.status === "approved" && !acts.some((a) => ["PUBLISH", "UPDATE_PUBLICATION", "AUTO_PUBLISH"].includes(a.action_type) && a.target_id === id && !["failed", "cancelled", "blocked", "skipped"].includes(a.status)) && snapshot.publish_after_human_approval && !art.high_risk))) waiting = true;
    }
    const warnings = acts.some((a) => ["failed", "blocked", "completed_with_warnings"].includes(a.status));
    const usage = await this.runUsage(run, acts);
    let status;
    if (stopped) status = "paused";
    else if (inflight.length) status = "monitoring";
    else if (waiting) status = "waiting_for_approval";
    else status = warnings ? "completed_with_warnings" : "completed";
    const fresh = await this.one("autopilot_runs", run.id);
    const followUp = Boolean(fresh?.follow_up_requested);
    const patch = { current_step: { monitoring: "waiting for jobs", waiting_for_approval: "waiting for human approval", paused: "paused" }[status] || "done", action_count: acts.length, result: { ...(fresh?.result || {}), cycles, gsc_state: gsc.state === "no_data" ? "WAIT_FOR_MORE_DATA" : gsc.state }, follow_up_requested: false, ...usage };
    if (["completed", "completed_with_warnings"].includes(status)) patch.completed_at = this.ts();
    await this.transition("run", run.id, status, patch);
    if (["completed", "completed_with_warnings"].includes(status)) {
      await this.event(run, "run_completed", `Run ${status.replace(/_/g, " ")} — ${acts.length} action(s)`, { actions: acts.length });
      await this.audit(run, "AUTOPILOT_RUN_COMPLETED", "autopilot_run", run.id, { status, actions: acts.length, cycles });
      if (followUp) await this.createRun(run, "follow_up", run.id);
    }
    return { status, actions: acts.length };
  }

  async runUsage(run, acts) {
    const jobIds = acts.filter((a) => a.job_type === "content_job" && a.job_id).map((a) => `content_job = "${a.job_id}"`);
    if (!jobIds.length) return { ai_cost_status: "none", actual_ai_cost: 0, ai_usage: { calls: 0, tokens: 0 } };
    const rows = await this.all("ai_usage", `(${jobIds.join(" || ")})`, { fields: "input_tokens,output_tokens,estimated_cost,cost_status" });
    const unknown = rows.some((r) => r.cost_status !== "calculated");
    return { ai_cost_status: rows.length === 0 ? "none" : unknown ? "unknown" : "known", actual_ai_cost: unknown ? 0 : rows.reduce((s, r) => s + (Number(r.estimated_cost) || 0), 0), ai_usage: { calls: rows.length, tokens: rows.reduce((s, r) => s + (r.input_tokens || 0) + (r.output_tokens || 0), 0), cost: unknown ? "unknown" : undefined } };
  }

  // ------------------------------------------------------------ triggers / scheduler
  async createRun(scope, trigger, ref = "") {
    const policy = await this.first("autopilot_policies", `website = "${esc(scope.website)}"`);
    if (!policy || !policy.enabled || policy.mode === "OFF" || policy.paused) return null;
    if (await this.orgPaused(scope.organization)) return null;
    try {
      const r = await this.col("autopilot_runs").create({ organization: policy.organization, client: policy.client, website: policy.website, policy: policy.id, trigger, trigger_ref: ref, dry_run: false, status: "queued", mode: policy.mode, current_step: "queued", signal_count: 0, decision_count: 0, action_count: 0, result: {}, created_at: this.ts(), updated_at: this.ts() }, { requestKey: null });
      return r;
    } catch (e) {
      // Unique active-run index: a hot run already exists → merge.
      const hot = await this.first("autopilot_runs", `website = "${esc(scope.website)}" && dry_run = false && (${HOT.map((s) => `status = "${s}"`).join(" || ")})`);
      if (hot) { await this.col("autopilot_runs").update(hot.id, { follow_up_requested: true, updated_at: this.ts() }, { requestKey: null }); return null; }
      throw e;
    }
  }

  async consumeTriggers(limit = 20) {
    const list = await this.col("autopilot_triggers").getList(1, limit, { filter: `status = "pending"`, sort: "created_at", requestKey: null });
    for (const t of list.items) {
      const scope = { organization: t.organization, client: t.client, website: t.website };
      const policy = await this.first("autopilot_policies", `website = "${esc(t.website)}"`);
      const mark = (status, note, run = "") => this.col("autopilot_triggers").update(t.id, { status, note, run, processed_at: this.ts(), updated_at: this.ts() }, { requestKey: null });
      if (!policy || !policy.enabled || policy.mode === "OFF") { await mark("ignored", "Autopilot is OFF"); continue; }
      if (policy.paused || (await this.orgPaused(t.organization))) { await mark("ignored", "Autopilot paused; state is re-read on the next run"); continue; }
      const hot = await this.first("autopilot_runs", `website = "${esc(t.website)}" && dry_run = false && (${HOT.map((s) => `status = "${s}"`).join(" || ")})`);
      if (hot) {
        await this.col("autopilot_runs").update(hot.id, { follow_up_requested: true, updated_at: this.ts() }, { requestKey: null });
        await mark("merged", "Merged into the active run", hot.id);
        continue;
      }
      const parked = await this.first("autopilot_runs", `website = "${esc(t.website)}" && dry_run = false && (${PARKED.map((s) => `status = "${s}"`).join(" || ")})`, { sort: "-created_at" });
      if (parked) {
        // Continue the SAME logical workflow from where it stopped.
        await this.col("autopilot_runs").update(parked.id, { result: { ...(parked.result || {}), resume_trigger: t.trigger, resume_ref: t.entity_id }, updated_at: this.ts() }, { requestKey: null });
        await mark("processed", `Resumed run ${parked.id}`, parked.id);
        await this.processRun(parked.id);
        continue;
      }
      // Only meaningful events start a new run; the rest are recorded.
      const starts = ["crawl_completed", "strategy_completed", "gsc_sync_completed", "analytics_opportunity_created", "article_approved", "publication_failed", "follow_up"];
      if (!starts.includes(t.trigger)) { await mark("ignored", "No Autopilot workflow is waiting for this event"); continue; }
      const cooldown = Number(policy.cooldown_hours || 24) * 3600_000;
      const recent = await this.first("autopilot_runs", `website = "${esc(t.website)}" && dry_run = false && trigger = "${esc(t.trigger)}" && created_at >= "${pbDate(this.now() - cooldown)}"`);
      if (recent && t.trigger !== "article_approved" && t.trigger !== "publication_failed") { await mark("ignored", `Cooldown ${policy.cooldown_hours}h for ${t.trigger} runs`); continue; }
      const run = await this.createRun(scope, t.trigger, `${t.entity_type}:${t.entity_id}`);
      await mark(run ? "processed" : "merged", run ? "New run" : "Merged", run?.id || "");
      if (run) await this.processRun(run.id);
    }
    return list.items.length;
  }

  async schedule() {
    const due = await this.all("autopilot_policies", `enabled = true && paused = false && mode != "OFF" && schedule != "manual_only" && next_run_at != "" && next_run_at <= "${pbDate(this.now())}"`);
    const created = [];
    for (const p of due) {
      if (await this.orgPaused(p.organization)) continue;
      const interval = p.schedule === "daily" ? DAY : 7 * DAY;
      await this.col("autopilot_policies").update(p.id, { next_run_at: iso(this.now() + interval), last_run_at: this.ts() }, { requestKey: null });
      const r = await this.createRun({ organization: p.organization, client: p.client, website: p.website }, "scheduled");
      if (r) created.push(r.id);
    }
    return created;
  }

  // Parked runs re-check in-flight jobs periodically (cheap; no AI). This is a
  // safety net for missed events, NOT an infinite wait: only runs with queued/
  // running jobs are touched; waiting_for_approval runs resume only on events.
  async sweepMonitoring() {
    const runs = await this.all("autopilot_runs", `status = "monitoring" && dry_run = false`, { fields: "id,updated_at", sort: "updated_at" });
    for (const r of runs.slice(0, 10)) if (Date.parse(String(r.updated_at).replace(" ", "T")) < this.now() - 60_000) await this.processRun(r.id);
  }

  async claimQueued() {
    const cutoff = pbDate(this.now());
    const list = await this.col("autopilot_runs").getList(1, 5, { filter: `(status = "queued" || ((${HOT.map((s) => `status = "${s}"`).join(" || ")}) && (lease_until = "" || lease_until < "${cutoff}")))`, sort: "created_at", requestKey: null });
    for (const r of list.items) await this.processRun(r.id);
    return list.items.length;
  }

  async heartbeat(extra = {}) {
    const existing = await this.first("service_heartbeats", `service = "bunker-seo-autopilot"`);
    const data = { service: "bunker-seo-autopilot", version: WORKER_VERSION, instance: this.workerId, last_seen_at: this.ts(), details: extra };
    if (existing) await this.col("service_heartbeats").update(existing.id, data, { requestKey: null });
    else await this.col("service_heartbeats").create(data, { requestKey: null });
  }

  async tick() {
    await this.claimQueued();
    await this.consumeTriggers();
    await this.schedule();
    await this.claimQueued();
    await this.sweepMonitoring();
  }
}

const PUBLISHED = ["publish_queued", "publishing", "published", "publish_failed", "unpublished"];

function normalize(v) {
  return String(v ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9ñ]+/g, " ").trim();
}

// Deterministic human-readable explanation built ONLY from structured evidence
// (the optional AI planner is not enabled; nothing here is invented).
export function explain(d, run, snapshot) {
  const parts = [`Trigger: ${run.trigger}.`];
  if (d.signal) parts.push(`Signal: ${d.signal.signal_type} from ${d.signal.source}${d.signal.source_record ? ` (${d.signal.source_record})` : ""}.`);
  parts.push(`Decision: ${d.decision_type} (${d.priority}${d.score ? `, score ${d.score}` : ""}) by rule ${d.rule}.`);
  parts.push(`Why: ${d.reason}`);
  parts.push(`Policy v${snapshot.version}: mode ${snapshot.mode}, publish after human approval ${snapshot.publish_after_human_approval ? "ON" : "OFF"}.`);
  if (d.planned_action) parts.push(`Action: ${d.planned_action.action_type} → ${d.planned_action.target_type} ${d.planned_action.target_id}${d.block_code ? ` [blocked: ${d.block_code}]` : ""}.`);
  return parts.join(" ");
}
