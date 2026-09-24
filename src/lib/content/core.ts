// Phase 4 content engine — READ-ONLY helpers used by the Next.js app.
//
// All mutations (generate, edit, restore, approve, reject, request revision,
// retry, recheck, cancel, brief edits) run INSIDE PocketBase as authenticated
// user endpoints (pb_hooks/bsa_lib.js). The app calls them with the signed-in
// user's token and never holds superuser credentials. This module only reads
// through the session client, so PocketBase's tenant rules apply to every
// query here as well. Nothing here publishes anything.
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

/** UI gate only — PocketBase re-checks the role on every write. */
export function canManageContent(role: string | undefined): boolean {
  return Boolean(role) && role !== "viewer" && role !== "client";
}

function assertWriter(actor: ContentActor) {
  if (!actor?.organization) throw new ContentError("FORBIDDEN", "Your account is not linked to an organization.");
  if (!canManageContent(actor.role)) throw new ContentError("FORBIDDEN", "You do not have permission to manage content.");
}

function assertOrg(record: Rec | null, actor: ContentActor, label: string): Rec {
  if (!record || record.organization !== actor.organization) throw new ContentError("NOT_FOUND", `${label} not found.`);
  return record;
}

// ---------------------------------------------------------------------------
// Generation preview (read-only)

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

/** Pre-generation form data, read through the SESSION client (PB rules apply). */
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

// ---------------------------------------------------------------------------
// Versions / review (pure)

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

/** Mirror of the server-side check in pb_hooks/bsa_lib.js (UI hints only). */
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

// ---------------------------------------------------------------------------
// Reads (session client only)

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
