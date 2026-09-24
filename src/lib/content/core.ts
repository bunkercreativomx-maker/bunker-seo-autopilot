// Phase 4 content engine — human-side operations (generation trigger, edits,
// versions, restore, approval, rejection, revision requests, retry).
//
// Framework-free on purpose: server actions call it with an authenticated
// superuser client AFTER resolving the session user, and the integration
// suite exercises exactly the same code against a local PocketBase.
// Every operation re-checks tenant ownership of every record it touches.
// Nothing here publishes anything: "approved" is the terminal Phase 4 state.
import type PocketBase from "pocketbase";

export type ContentActor = { id: string; organization: string; role: string; name?: string; email?: string };

export const CONTENT_TYPES = ["blog_article", "service_page", "location_page", "guide", "comparison", "faq_page", "existing_page_optimization"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export const ARTICLE_STATUSES = ["researching", "brief_ready", "outline_ready", "drafting", "draft", "qa", "needs_revision", "awaiting_approval", "approved", "rejected", "failed"] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

export class ContentError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ContentError";
    this.code = code;
  }
}

const now = () => new Date().toISOString();
const esc = (value: string) => String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const clean = (value: unknown, max: number) => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, max);

type Rec = Record<string, unknown> & { id: string; organization?: string; client?: string; website?: string };

async function getOne(pb: PocketBase, collection: string, id: string): Promise<Rec | null> {
  if (!id) return null;
  try {
    return await pb.collection(collection).getOne<Rec>(id, { requestKey: null });
  } catch (error) {
    if ((error as { status?: number })?.status === 404) return null;
    throw error;
  }
}

function assertWriter(actor: ContentActor) {
  if (!actor?.organization) throw new ContentError("FORBIDDEN", "Your account is not linked to an organization.");
  if (actor.role === "viewer" || actor.role === "client") throw new ContentError("FORBIDDEN", "You do not have permission to manage content.");
}

function assertOrg(record: Rec | null, actor: ContentActor, label: string): Rec {
  if (!record || record.organization !== actor.organization) throw new ContentError("NOT_FOUND", `${label} not found.`);
  return record;
}

export async function getArticleForActor(pb: PocketBase, actor: ContentActor, articleId: string): Promise<Rec> {
  return assertOrg(await getOne(pb, "articles", articleId), actor, "Article");
}

async function activity(pb: PocketBase, article: Rec, actor: ContentActor | null, action: string, metadata: Record<string, unknown> = {}) {
  try {
    await pb.collection("activity_logs").create({
      organization: article.organization, client: article.client, website: article.website, user: actor?.id ?? "",
      action, entity_type: "article", entity_id: article.id, metadata, created_at: now(),
    }, { requestKey: null });
  } catch (error) {
    console.warn("[content] activity log failed", action, error);
  }
}

// ---------------------------------------------------------------------------
// Generation inputs

const PAGE_TYPE_TO_CONTENT: Record<string, ContentType> = {
  blog_post: "blog_article", blog_article: "blog_article", article: "blog_article",
  service_page: "service_page", service: "service_page",
  location_page: "location_page", location: "location_page",
  guide: "guide", pillar_page: "guide", pillar: "guide",
  comparison: "comparison", comparison_page: "comparison",
  faq: "faq_page", faq_page: "faq_page",
};

export function inferContentType(input: { opportunity_type?: string; page_type?: string; action?: string; existing_page?: string }): ContentType {
  // Accept both vocabularies: opportunity_type (optimize/location/...) and plan
  // item action (optimize_existing_page/create_location_page/...).
  const action = String(input.opportunity_type || input.action || "").toLowerCase();
  if (input.existing_page && ["optimize", "expand", "refresh", "merge", "optimize_existing_page", "expand_existing_page", "merge_content"].includes(action)) return "existing_page_optimization";
  if (action === "location" || action === "create_location_page") return "location_page";
  if (action === "service" || action === "create_service_page") return "service_page";
  if (action === "create_blog_post") return "blog_article";
  return PAGE_TYPE_TO_CONTENT[String(input.page_type || "").toLowerCase()] ?? "blog_article";
}

export type GenerationSource = { kind: "opportunity" | "plan_item"; id: string };
export type GenerationInputs = {
  content_type: ContentType;
  primary_keyword: string;
  target_location: string;
  recommended_url: string;
  reason: string;
  language: string;
  pause_after_brief?: boolean;
};

export function generationKey(source: GenerationSource): string {
  return `${source.kind === "opportunity" ? "opp" : "plan"}:${source.id}`;
}

/**
 * An article already produced for this source — directly (generation_key) or
 * through the linked opportunity (a plan item derived from an opportunity that
 * already has content, or vice versa). Rejected articles do not block a new
 * attempt from the other entry point, but still block their own key.
 */
async function findExistingArticle(pb: PocketBase, key: string, opportunityId: string): Promise<Rec | null> {
  const direct = await pb.collection("articles").getList<Rec>(1, 1, { filter: `generation_key = "${esc(key)}"`, requestKey: null });
  if (direct.items[0]) return direct.items[0];
  if (!opportunityId) return null;
  const linked = await pb.collection("articles").getList<Rec>(1, 1, { filter: `content_opportunity = "${esc(opportunityId)}" && status != "rejected"`, sort: "-created_at", requestKey: null });
  return linked.items[0] ?? null;
}

async function resolveSource(pb: PocketBase, actor: ContentActor, websiteId: string, source: GenerationSource) {
  const website = assertOrg(await getOne(pb, "websites", websiteId), actor, "Website");
  const collection = source.kind === "opportunity" ? "content_opportunities" : "content_plan_items";
  const record = assertOrg(await getOne(pb, collection, source.id), actor, source.kind === "opportunity" ? "Opportunity" : "Plan item");
  if (record.website !== website.id || record.client !== website.client) throw new ContentError("NOT_FOUND", "Source does not belong to this website.");
  const approvedStates = source.kind === "opportunity" ? ["approved"] : ["approved", "in_progress"];
  if (!approvedStates.includes(String(record.status))) throw new ContentError("NOT_APPROVED", "Only approved opportunities or plan items can generate content.");
  if (source.kind === "opportunity" && ["internal_link", "ignore"].includes(String(record.opportunity_type))) throw new ContentError("UNSUPPORTED", "This opportunity type does not generate content.");
  if (source.kind === "plan_item" && ["add_internal_links", "fix_technical_issue", "ignore"].includes(String(record.action))) throw new ContentError("UNSUPPORTED", "This plan action does not generate content.");
  let opportunity: Rec | null = source.kind === "opportunity" ? record : null;
  if (!opportunity && record.opportunity) {
    const linked = await getOne(pb, "content_opportunities", String(record.opportunity));
    if (linked && linked.organization === actor.organization && linked.website === website.id) opportunity = linked;
  }
  const keywordId = String(record.keyword || opportunity?.keyword || "");
  const keyword = keywordId ? await getOne(pb, "keywords", keywordId) : null;
  if (keyword && keyword.website !== website.id) throw new ContentError("NOT_FOUND", "Keyword does not belong to this website.");
  const client = assertOrg(await getOne(pb, "clients", String(website.client)), actor, "Client");
  return { website, client, record, opportunity, keyword };
}

export type GenerationPreview = {
  source: GenerationSource;
  defaults: GenerationInputs;
  business_context: { business_name: string; verified_facts: Array<{ label: string; value: string }>; unverified_fact_count: number; declared_services: string; declared_locations: string; brand_voice: string };
  existing_article: { id: string; status: string } | null;
  existing_page_url: string;
  website: { id: string; name: string; domain: string; client: string };
};

export async function prepareGeneration(pb: PocketBase, actor: ContentActor, websiteId: string, source: GenerationSource): Promise<GenerationPreview> {
  assertWriter(actor);
  const { website, client, record, opportunity, keyword } = await resolveSource(pb, actor, websiteId, source);
  const existingArticle = await findExistingArticle(pb, generationKey(source), String(opportunity?.id || ""));
  const facts = await pb.collection("business_facts").getFullList<Rec>({ filter: `website = "${esc(website.id)}" && client = "${esc(String(website.client))}"`, requestKey: null });
  const verified = facts.filter((f) => (f.verified === true || ["verified", "user_confirmed"].includes(String(f.verification_state))) && f.verification_state !== "ai_inferred" && f.provenance !== "ai_inferred");
  const existingPageId = String(record.existing_page || opportunity?.existing_page || "");
  const existingPage = existingPageId ? await getOne(pb, "website_pages", existingPageId) : null;
  const content_type = inferContentType({
    opportunity_type: String(opportunity?.opportunity_type || ""), action: String(record.action || ""),
    page_type: String(record.page_type || opportunity?.recommended_page_type || ""), existing_page: existingPageId,
  });
  const locationFromKeyword = content_type === "location_page" ? String(keyword?.target_location || "") : "";
  return {
    source,
    defaults: {
      content_type,
      primary_keyword: clean(keyword?.keyword || record.proposed_title || opportunity?.title_suggestion, 200),
      target_location: clean(locationFromKeyword || (content_type === "location_page" ? client.primary_location : ""), 200),
      recommended_url: clean(record.proposed_url || opportunity?.recommended_url || existingPage?.url, 500),
      reason: clean(record.reason || opportunity?.reason, 1500),
      language: clean(website.primary_language || client.primary_language || "es", 10) || "es",
    },
    business_context: {
      business_name: clean(client.business_name, 200),
      verified_facts: verified.slice(0, 30).map((f) => ({ label: clean(f.label, 120), value: clean(f.value, 300) })),
      unverified_fact_count: facts.length - verified.length,
      declared_services: clean(client.services, 600),
      declared_locations: clean([client.primary_location, client.service_areas].filter(Boolean).join(" · "), 400),
      brand_voice: clean(client.brand_voice, 300),
    },
    existing_article: existingArticle ? { id: existingArticle.id, status: String(existingArticle.status) } : null,
    existing_page_url: clean(existingPage?.url, 500),
    website: { id: website.id, name: clean(website.name, 200), domain: clean(website.domain, 200), client: String(website.client) },
  };
}

export function validateInputs(raw: Record<string, unknown>): GenerationInputs {
  const content_type = String(raw.content_type || "") as ContentType;
  if (!CONTENT_TYPES.includes(content_type)) throw new ContentError("INVALID", "Invalid content type.");
  const primary_keyword = clean(raw.primary_keyword, 200);
  if (primary_keyword.length < 2) throw new ContentError("INVALID", "Primary keyword is required.");
  const target_location = clean(raw.target_location, 200);
  if (content_type === "location_page" && !target_location) throw new ContentError("INVALID", "Location pages require a target location.");
  const recommended_url = clean(raw.recommended_url, 500);
  if (recommended_url && !/^(\/|https?:\/\/)[^\s<>"']*$/.test(recommended_url)) throw new ContentError("INVALID", "Recommended URL must be a path (/...) or http(s) URL.");
  const language = clean(raw.language, 10).toLowerCase();
  if (!/^[a-z]{2}(-[a-z]{2})?$/.test(language)) throw new ContentError("INVALID", "Language must be an ISO code like es or en-US.");
  return { content_type, primary_keyword, target_location, recommended_url, reason: clean(raw.reason, 1500), language, pause_after_brief: raw.pause_after_brief === true || raw.pause_after_brief === "on" };
}

const RATE_LIMIT_PER_HOUR = Number(process.env.CONTENT_JOBS_PER_HOUR || 30);

async function assertRateLimit(pb: PocketBase, organization: string) {
  const since = new Date(Date.now() - 3600_000).toISOString().replace("T", " ");
  const recent = await pb.collection("content_jobs").getList(1, 1, { filter: `organization = "${esc(organization)}" && created_at >= "${since}"`, requestKey: null });
  if (recent.totalItems >= RATE_LIMIT_PER_HOUR) throw new ContentError("RATE_LIMITED", `Content generation limit reached (${RATE_LIMIT_PER_HOUR}/hour). Try again later.`);
}

async function activeJob(pb: PocketBase, articleId: string): Promise<Rec | null> {
  const res = await pb.collection("content_jobs").getList<Rec>(1, 1, { filter: `article = "${esc(articleId)}" && (status = "queued" || status = "running")`, requestKey: null });
  return res.items[0] ?? null;
}

async function createJob(pb: PocketBase, article: Rec, actor: ContentActor, fields: Record<string, unknown>): Promise<Rec> {
  const existing = await activeJob(pb, article.id);
  if (existing) return existing;
  await assertRateLimit(pb, actor.organization);
  const ts = now();
  try {
    return await pb.collection("content_jobs").create<Rec>({
      organization: article.organization, client: article.client, website: article.website, article: article.id,
      opportunity: article.content_opportunity || "", plan_item: article.content_plan_item || "",
      status: "queued", step: "queued", progress: 0, triggered_by: actor.id, attempt: 0, created_at: ts, updated_at: ts, ...fields,
    }, { requestKey: null });
  } catch (error) {
    // Partial unique index (one active job per article) lost a race: return the winner.
    const winner = await activeJob(pb, article.id);
    if (winner) return winner;
    throw error;
  }
}

/**
 * Idempotent: the article is keyed by its source (generation_key, unique
 * index). Repeated clicks return the same article and the same active job.
 */
export async function startGeneration(pb: PocketBase, actor: ContentActor, websiteId: string, source: GenerationSource, rawInputs: Record<string, unknown>): Promise<{ article: Rec; job: Rec | null; created: boolean }> {
  assertWriter(actor);
  const { website, record, opportunity, keyword } = await resolveSource(pb, actor, websiteId, source);
  const inputs = validateInputs(rawInputs);
  const key = generationKey(source);
  const found = await findExistingArticle(pb, key, String(opportunity?.id || ""));
  if (found) {
    const article = assertOrg(found, actor, "Article");
    return { article, job: await activeJob(pb, article.id), created: false };
  }
  const existingPageId = String(record.existing_page || opportunity?.existing_page || "");
  if (inputs.content_type === "existing_page_optimization" && !existingPageId) throw new ContentError("INVALID", "Existing page optimization requires an opportunity linked to an existing page.");
  const ts = now();
  let article: Rec;
  try {
    article = await pb.collection("articles").create<Rec>({
      organization: actor.organization, client: website.client, website: website.id,
      content_opportunity: opportunity?.id || "", content_plan_item: source.kind === "plan_item" ? record.id : "",
      keyword: keyword?.id || "", cluster: String(record.cluster || opportunity?.cluster || ""),
      existing_page: inputs.content_type === "existing_page_optimization" ? existingPageId : "",
      content_type: inputs.content_type, status: "researching", language: inputs.language,
      primary_keyword: inputs.primary_keyword, target_location: inputs.target_location, recommended_url: inputs.recommended_url,
      secondary_keywords: [], flags: [], risk_categories: [], pipeline_state: {}, revision_cycles: 0, current_version: 0,
      qa_status: "pending", fact_check_status: "pending", content_format: "markdown",
      generation_key: key, generation_input: { ...inputs, source }, created_by: actor.id, author: clean(actor.name || actor.email, 200),
      created_at: ts, updated_at: ts,
    }, { requestKey: null });
  } catch (error) {
    const again = await pb.collection("articles").getList<Rec>(1, 1, { filter: `generation_key = "${esc(key)}"`, requestKey: null });
    if (again.items[0]) return { article: again.items[0], job: await activeJob(pb, again.items[0].id), created: false };
    throw error;
  }
  const job = await createJob(pb, article, actor, { mode: "generate", configuration: { pause_after_brief: Boolean(inputs.pause_after_brief) } });
  if (source.kind === "plan_item" && record.status === "approved") {
    await pb.collection("content_plan_items").update(record.id, { status: "in_progress", updated_at: ts }, { requestKey: null }).catch(() => undefined);
  }
  await activity(pb, article, actor, "CONTENT_GENERATION_STARTED", { source: key, content_type: inputs.content_type, job: job?.id });
  return { article, job, created: true };
}

// ---------------------------------------------------------------------------
// Jobs: retry / continue after brief / recheck / cancel

export async function retryGeneration(pb: PocketBase, actor: ContentActor, articleId: string): Promise<Rec> {
  assertWriter(actor);
  const article = await getArticleForActor(pb, actor, articleId);
  if (["approved", "rejected"].includes(String(article.status))) throw new ContentError("INVALID_STATE", "Approved or rejected content cannot be regenerated.");
  const running = await activeJob(pb, article.id);
  if (running) return running;
  const last = (await pb.collection("content_jobs").getList<Rec>(1, 1, { filter: `article = "${esc(article.id)}"`, sort: "-created_at", requestKey: null })).items[0];
  if (!last || last.status !== "failed") throw new ContentError("INVALID_STATE", "Only failed jobs can be retried.");
  const mode = last.mode === "revision" ? "revision" : last.mode === "recheck" ? "recheck" : "continue";
  const job = await createJob(pb, article, actor, { mode, configuration: last.configuration ?? {}, revision_instruction: last.revision_instruction ?? "", attempt: Number(last.attempt || 0) + 1 });
  await pb.collection("articles").update(article.id, { status: article.content ? article.status : "researching", updated_at: now() }, { requestKey: null });
  return job;
}

export async function continueAfterBrief(pb: PocketBase, actor: ContentActor, articleId: string): Promise<Rec> {
  assertWriter(actor);
  const article = await getArticleForActor(pb, actor, articleId);
  if (article.status !== "brief_ready") throw new ContentError("INVALID_STATE", "The article is not waiting on brief review.");
  return createJob(pb, article, actor, { mode: "continue", configuration: { pause_after_brief: false } });
}

export async function requestRecheck(pb: PocketBase, actor: ContentActor, articleId: string): Promise<Rec> {
  assertWriter(actor);
  const article = await getArticleForActor(pb, actor, articleId);
  if (!article.content) throw new ContentError("INVALID_STATE", "There is no draft to check.");
  if (["approved", "rejected"].includes(String(article.status))) throw new ContentError("INVALID_STATE", "Approved or rejected content is locked.");
  return createJob(pb, article, actor, { mode: "recheck" });
}

export async function cancelJob(pb: PocketBase, actor: ContentActor, jobId: string): Promise<void> {
  assertWriter(actor);
  const job = assertOrg(await getOne(pb, "content_jobs", jobId), actor, "Job");
  if (job.status !== "queued") throw new ContentError("INVALID_STATE", "Only queued jobs can be cancelled.");
  await pb.collection("content_jobs").update(job.id, { status: "cancelled", step: "cancelled", completed_at: now(), updated_at: now() }, { requestKey: null });
}

// ---------------------------------------------------------------------------
// Brief editing (before drafting)

export async function saveBrief(pb: PocketBase, actor: ContentActor, articleId: string, briefJson: string): Promise<void> {
  assertWriter(actor);
  const article = await getArticleForActor(pb, actor, articleId);
  if (!["brief_ready", "outline_ready"].includes(String(article.status))) throw new ContentError("INVALID_STATE", "The brief can only be edited before drafting.");
  let brief: unknown;
  try { brief = JSON.parse(briefJson); } catch { throw new ContentError("INVALID", "Brief must be valid JSON."); }
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) throw new ContentError("INVALID", "Brief must be a JSON object.");
  if (briefJson.length > 200_000) throw new ContentError("INVALID", "Brief is too large.");
  const b = brief as Record<string, unknown>;
  b.edited_by_human = true;
  const state = { ...((article.pipeline_state as Record<string, unknown>) || {}), outline: false };
  await pb.collection("articles").update(article.id, { brief: b, outline: null, pipeline_state: state, status: "brief_ready", updated_at: now() }, { requestKey: null });
}

// ---------------------------------------------------------------------------
// Versions

async function nextVersion(pb: PocketBase, articleId: string): Promise<number> {
  const latest = await pb.collection("article_versions").getList<Rec>(1, 1, { filter: `article = "${esc(articleId)}"`, sort: "-version", requestKey: null });
  return (Number(latest.items[0]?.version) || 0) + 1;
}

async function writeVersion(pb: PocketBase, article: Rec, fields: Record<string, string>, changeType: string, reason: string, actor: ContentActor | null): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const version = await nextVersion(pb, article.id);
    try {
      await pb.collection("article_versions").create({
        organization: article.organization, client: article.client, website: article.website, article: article.id, version,
        title: fields.title, content: fields.content, seo_title: fields.seo_title, meta_description: fields.meta_description,
        excerpt: fields.excerpt, slug: fields.slug, change_type: changeType, change_reason: clean(reason, 2000),
        created_by: actor?.id ?? "", created_by_label: clean(actor?.name || actor?.email || "", 200), created_at: now(),
      }, { requestKey: null });
      return version;
    } catch (error) {
      if (attempt === 2) throw error; // unique (article, version) race — retry with the next number
    }
  }
  throw new ContentError("CONFLICT", "Could not create version.");
}

const EDITABLE = ["title", "slug", "seo_title", "meta_description", "excerpt", "content"] as const;
const LIMITS: Record<(typeof EDITABLE)[number], number> = { title: 300, slug: 200, seo_title: 200, meta_description: 400, excerpt: 1000, content: 300_000 };

function snapshot(article: Rec): Record<string, string> {
  return Object.fromEntries(EDITABLE.map((f) => [f, String(article[f] ?? "")]));
}

/** Manual edit: never overwrites without a version; invalidates QA/fact check. */
export async function saveManualEdit(pb: PocketBase, actor: ContentActor, articleId: string, raw: Record<string, unknown>, reason = ""): Promise<{ changed: boolean; version?: number }> {
  assertWriter(actor);
  const article = await getArticleForActor(pb, actor, articleId);
  if (["approved", "rejected"].includes(String(article.status))) throw new ContentError("INVALID_STATE", "Approved or rejected content is locked. Request a revision instead.");
  if (await activeJob(pb, article.id)) throw new ContentError("BUSY", "A content job is running for this article. Wait for it to finish before editing.");
  const next: Record<string, string> = {};
  for (const field of EDITABLE) {
    const value = raw[field];
    next[field] = value === undefined ? String(article[field] ?? "") : field === "content" ? String(value).replace(/\r\n/g, "\n").slice(0, LIMITS[field]) : clean(value, LIMITS[field]);
  }
  if (next.slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(next.slug)) throw new ContentError("INVALID", "Slug must be lowercase letters, numbers and hyphens.");
  const before = snapshot(article);
  if (EDITABLE.every((f) => before[f] === next[f])) return { changed: false };
  const version = await writeVersion(pb, article, next, "manual_edit", reason || "Manual edit", actor);
  await pb.collection("articles").update(article.id, {
    ...next, current_version: version, status: "draft", qa_status: "stale", fact_check_status: "stale", updated_at: now(),
  }, { requestKey: null });
  return { changed: true, version };
}

export async function restoreVersion(pb: PocketBase, actor: ContentActor, articleId: string, version: number): Promise<number> {
  assertWriter(actor);
  const article = await getArticleForActor(pb, actor, articleId);
  if (["approved", "rejected"].includes(String(article.status))) throw new ContentError("INVALID_STATE", "Approved or rejected content is locked.");
  if (await activeJob(pb, article.id)) throw new ContentError("BUSY", "A content job is running for this article.");
  const found = await pb.collection("article_versions").getList<Rec>(1, 1, { filter: `article = "${esc(article.id)}" && version = ${Number(version) | 0}`, requestKey: null });
  const source = found.items[0];
  if (!source || source.organization !== actor.organization) throw new ContentError("NOT_FOUND", "Version not found.");
  const fields = Object.fromEntries(EDITABLE.map((f) => [f, String(source[f] ?? "")]));
  const created = await writeVersion(pb, article, fields, "restore", `Restored version ${source.version}`, actor);
  await pb.collection("articles").update(article.id, { ...fields, current_version: created, status: "draft", qa_status: "stale", fact_check_status: "stale", updated_at: now() }, { requestKey: null });
  return created;
}

/** Line-level diff (LCS) for the Compare view. */
export function diffLines(a: string, b: string): Array<{ type: "same" | "add" | "del"; text: string }> {
  const x = String(a ?? "").split("\n");
  const y = String(b ?? "").split("\n");
  if (x.length * y.length > 4_000_000) return [...x.map((text) => ({ type: "del" as const, text })), ...y.map((text) => ({ type: "add" as const, text }))];
  const dp: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Array<{ type: "same" | "add" | "del"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { out.push({ type: "same", text: x[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: "del", text: x[i++] });
    else out.push({ type: "add", text: y[j++] });
  }
  while (i < x.length) out.push({ type: "del", text: x[i++] });
  while (j < y.length) out.push({ type: "add", text: y[j++] });
  return out;
}

// ---------------------------------------------------------------------------
// Review decisions

export function approvalBlockers(article: Rec): string[] {
  const blockers: string[] = [];
  if (article.status !== "awaiting_approval") blockers.push(`Status is ${article.status}; only content awaiting approval can be approved.`);
  if (article.qa_status === "BLOCKED") blockers.push("QA is BLOCKED.");
  if (article.qa_status === "stale" || article.qa_status === "pending") blockers.push("QA has not run on the current version.");
  if (article.fact_check_status === "blocked") blockers.push("Fact check found high-risk unsupported or contradicted claims.");
  const flags = (article.flags as string[]) || [];
  if (flags.includes("RESEARCH_REQUIRED")) blockers.push("Research is required before this topic can be approved.");
  if (flags.includes("LANGUAGE_MISMATCH")) blockers.push("Draft language does not match the configured language.");
  if (!String(article.content || "").trim()) blockers.push("There is no content.");
  return blockers;
}

export async function approveArticle(pb: PocketBase, actor: ContentActor, articleId: string, { acknowledgeHighRisk = false, acknowledgeWarnings = false } = {}): Promise<Rec> {
  assertWriter(actor);
  const article = await getArticleForActor(pb, actor, articleId);
  const blockers = approvalBlockers(article);
  if (blockers.length) throw new ContentError("NOT_APPROVABLE", blockers.join(" "));
  if (article.high_risk && !acknowledgeHighRisk) throw new ContentError("HIGH_RISK_REVIEW_REQUIRED", "High-risk content: confirm you reviewed the medical/legal/financial/safety claims.");
  if (article.qa_status === "NEEDS_REVISION" && !acknowledgeWarnings) throw new ContentError("WARNINGS_NOT_ACKNOWLEDGED", "QA still reports issues after the automatic revision limit. Confirm you reviewed them to approve.");
  const ts = now();
  const provenance = { ...((article.provenance as Record<string, unknown>) || {}), approved_version: article.current_version, auto_publish_allowed: false, high_risk_acknowledged: Boolean(article.high_risk && acknowledgeHighRisk) };
  const updated = await pb.collection("articles").update<Rec>(article.id, { status: "approved", approved_by: actor.id, approved_at: ts, provenance, updated_at: ts }, { requestKey: null });
  await activity(pb, article, actor, "ARTICLE_APPROVED", { version: article.current_version, qa_status: article.qa_status, high_risk: Boolean(article.high_risk) });
  return updated;
}

export async function rejectArticle(pb: PocketBase, actor: ContentActor, articleId: string, reason: string): Promise<Rec> {
  assertWriter(actor);
  const why = clean(reason, 2000);
  if (why.length < 3) throw new ContentError("INVALID", "A rejection reason is required.");
  const article = await getArticleForActor(pb, actor, articleId);
  if (article.status === "approved") throw new ContentError("INVALID_STATE", "Approved content cannot be rejected in Phase 4.");
  if (await activeJob(pb, article.id)) throw new ContentError("BUSY", "A content job is running for this article.");
  const ts = now();
  const updated = await pb.collection("articles").update<Rec>(article.id, { status: "rejected", rejected_by: actor.id, rejected_at: ts, rejection_reason: why, updated_at: ts }, { requestKey: null });
  await activity(pb, article, actor, "ARTICLE_REJECTED", { reason: why });
  return updated;
}

export async function requestRevision(pb: PocketBase, actor: ContentActor, articleId: string, instruction: string): Promise<Rec> {
  assertWriter(actor);
  const text = clean(instruction, 2000);
  if (text.length < 3) throw new ContentError("INVALID", "Write a revision instruction.");
  const article = await getArticleForActor(pb, actor, articleId);
  if (!article.content) throw new ContentError("INVALID_STATE", "There is no draft to revise yet.");
  if (article.status === "rejected") throw new ContentError("INVALID_STATE", "Rejected content cannot be revised.");
  if (article.status === "approved") {
    // Re-opening an approved draft clears approval; nothing was published.
    await pb.collection("articles").update(article.id, { status: "needs_revision", approved_by: "", approved_at: "", updated_at: now() }, { requestKey: null });
  } else {
    await pb.collection("articles").update(article.id, { status: "needs_revision", updated_at: now() }, { requestKey: null });
  }
  const job = await createJob(pb, article, actor, { mode: "revision", revision_instruction: text, configuration: {} });
  if (job.mode !== "revision" || job.revision_instruction !== text) throw new ContentError("BUSY", "Another job is already running for this article; try again when it finishes.");
  await activity(pb, article, actor, "REVISION_REQUESTED", { instruction: text, job: job.id });
  return job;
}

// ---------------------------------------------------------------------------
// Reads (tenant-scoped; callers pass the session client so PB rules also apply)

export async function articleUsage(pb: PocketBase, articleId: string) {
  const rows = await pb.collection("ai_usage").getFullList<Rec>({ filter: `article = "${esc(articleId)}"`, fields: "task,model,input_tokens,output_tokens,estimated_cost,cost_status", requestKey: null });
  const byTask = new Map<string, { calls: number; input: number; output: number }>();
  let input = 0;
  let output = 0;
  let cost = 0;
  let unpriced = 0;
  for (const row of rows) {
    input += Number(row.input_tokens) || 0;
    output += Number(row.output_tokens) || 0;
    if (row.cost_status === "calculated") cost += Number(row.estimated_cost) || 0;
    else unpriced++;
    const t = byTask.get(String(row.task)) ?? { calls: 0, input: 0, output: 0 };
    t.calls++; t.input += Number(row.input_tokens) || 0; t.output += Number(row.output_tokens) || 0;
    byTask.set(String(row.task), t);
  }
  return { calls: rows.length, input_tokens: input, output_tokens: output, estimated_cost: rows.length && unpriced === rows.length ? null : cost, unpriced_calls: unpriced, by_task: Object.fromEntries(byTask) };
}
