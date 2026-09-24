// Content pipeline orchestrator.
//
// APPROVED OPPORTUNITY → CONTENT JOB → CONTEXT → RESEARCH → SOURCES → BRIEF →
// OUTLINE → DRAFT → SEO/METADATA → INTERNAL LINKS → CLAIMS → FACT CHECK → QA →
// (bounded revision loop) → HUMAN REVIEW. Approval itself is a human action in
// the app; this worker can never set an article to "approved".
import { Budget } from "./budget.js";
import { limitsForJob } from "./config.js";
import { attachSources, buildContext, evidenceIndex } from "./context.js";
import {
  buildStructuredData, checkMetadata, detectRisk, duplicateCheck, enforceClaim, keywordStats,
  localDifferentiation, processLinks, repetitionStats, sanitizeSlug, scanUnsupportedSpecifics,
  structureStats, summarizeClaims,
} from "./checks.js";
import {
  createVersion, esc, loadJobData, logActivity, priorGenerationUsage, recordUsage, replaceForVersion,
  updateArticle, updateJob, upsertSources,
} from "./pb.js";
import { collectExternalSources, fetchSource, ResearchUnavailableError } from "./research.js";
import {
  runBrief, runClaimExtraction, runDraft, runFactCheck, runMetadata, runOutline, runQA, runResearchAnalysis, runRevision,
} from "./stages.js";
import { safeText, tokens } from "./text.js";

export const WORKER_VERSION = "bunker-seo-content/0.4.0";
export const SOURCE_STRATEGY = "evidence-first-v1";

export class PipelineStop extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PipelineStop";
    this.code = code;
    this.retryable = false;
  }
}

const STEPS = {
  building_context: 5, researching: 15, building_brief: 30, creating_outline: 40, writing_draft: 50,
  optimizing_seo: 62, checking_claims: 70, fact_checking: 76, quality_review: 84, revising: 90,
};

function sameHost(url, domain) {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase() === String(domain).replace(/^www\./, "").toLowerCase(); } catch { return false; }
}

/** Fetch readable text of the client's own most relevant pages (SSRF-safe, same host only). */
export async function loadPageTexts(data, { fetcher = fetchSource, limit = 6, primaryKeyword = "" } = {}) {
  const texts = new Map();
  const q = tokens(primaryKeyword);
  const ranked = [...data.pages]
    .filter((p) => p.status_code === 200 && sameHost(p.url, data.website.domain))
    .map((p) => ({ p, score: tokens(`${p.title} ${p.h1} ${p.path}`).filter((t) => q.includes(t)).length + (p.id === data.article.existing_page ? 100 : 0) + (p.path === "/" || p.path === "" ? 0.5 : 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  for (const { p } of ranked) {
    const result = await fetcher(p.url);
    if (result.ok && result.text && sameHost(result.finalUrl || p.url, data.website.domain)) texts.set(p.id, result.text);
  }
  return texts;
}

function researchQueries(context, extra = []) {
  const kw = context.meta.primary_keyword;
  const loc = context.meta.target_location;
  const base = [loc ? `${kw} ${loc}` : kw, kw];
  return [...new Set([...base, ...extra].map((q) => safeText(q, 200)).filter(Boolean))];
}

function computeQaStatus({ qa, claimSummary, specifics, duplicate, local, structure }) {
  const reasons = [];
  if (claimSummary.blocking) reasons.push(`${claimSummary.blocking} high-risk unsupported or contradicted claim(s)`);
  const blockerSpecifics = specifics.filter((s) => s.severity === "blocker");
  if (blockerSpecifics.length) reasons.push(`Unverified specifics: ${blockerSpecifics.map((s) => s.value).slice(0, 5).join(", ")}`);
  if (duplicate.level === "severe") reasons.push("Near-duplicate of existing content");
  if (local.level === "severe") reasons.push("Insufficient local differentiation");
  if (structure.languageMismatch) reasons.push(`Language mismatch (expected ${structure.expectedLanguage}, got ${structure.detectedLanguage})`);
  if (structure.h1 !== 1) reasons.push(`Expected exactly one H1, found ${structure.h1}`);
  const qaBlockers = qa.issues.filter((i) => i.severity === "blocker");
  if (qaBlockers.length) reasons.push(`${qaBlockers.length} QA blocker(s)`);
  if (reasons.length) return { status: "BLOCKED", reasons };
  const majors = qa.issues.filter((i) => i.severity === "major").length + specifics.filter((s) => s.severity === "major").length;
  const failedChecks = qa.checks.filter((c) => c.status === "fail").length;
  if (majors || failedChecks || claimSummary.unverified || duplicate.level === "warning" || local.level === "warning") {
    return { status: "NEEDS_REVISION", reasons: [majors && `${majors} major issue(s)`, failedChecks && `${failedChecks} failed check(s)`, claimSummary.unverified && `${claimSummary.unverified} unverified claim(s)`, duplicate.level === "warning" && "Partial overlap with existing content", local.level === "warning" && "Limited local evidence"].filter(Boolean) };
  }
  return { status: "PASS", reasons: [] };
}

export async function processContentJob(pb, job, deps) {
  const { provider, researchProvider, config, fetcher = fetchSource, logger = console, now = () => new Date().toISOString() } = deps;
  let article;
  let data;
  const progress = async (step) => { await updateJob(pb, job.id, { step, progress: STEPS[step] ?? 0 }); };
  try {
    data = await loadJobData(pb, job);
    article = data.article;
    const limits = limitsForJob(config, job.configuration || {});
    const prior = ["generate", "continue"].includes(job.mode) ? await priorGenerationUsage(pb, article, job.id) : {};
    const budget = new Budget(limits, prior);
    const ctx = { provider, config, budget, onUsage: (usage) => recordUsage(pb, usage, { job, article }) };
    const state = { ...(article.pipeline_state || {}) };
    const saveState = async (fields = {}) => { article = await updateArticle(pb, article.id, { pipeline_state: state, ...fields }); };

    await progress("building_context");
    const pageTexts = await loadPageTexts(data, { fetcher, primaryKeyword: article.primary_keyword });
    let context = buildContext(data, { pageTexts });
    if (article.content_type === "existing_page_optimization") {
      if (!context.existing_content) throw new PipelineStop("EXISTING_CONTENT_UNAVAILABLE", "Existing page content could not be retrieved; cannot propose a revision without the original.");
      if (!article.existing_content) article = await updateArticle(pb, article.id, { existing_content: context.existing_content });
    }

    // ------------------------------------------------------------ research
    let research;
    let sourceRecords = await pb.collection("research_sources").getFullList({ filter: `article = "${esc(article.id)}"`, sort: "created_at" });
    if (job.mode === "generate" || job.mode === "continue") {
      if (!state.research) {
        await progress("researching");
        await saveState({ status: "researching" });
        let researchNote = "";
        if (!sourceRecords.length && limits.maxResearchSources > 0) {
          try {
            const collected = await collectExternalSources({
              provider: researchProvider, queries: researchQueries(context), language: context.meta.language.split("-")[0],
              country: data.website.country || data.client.country, clientDomain: data.website.domain, maxSources: limits.maxResearchSources, fetcher, now, logger,
            });
            sourceRecords = await upsertSources(pb, article, collected.sources.map((s) => ({ ...s, provider: researchProvider.name })));
            researchNote = `${collected.sources.length} source(s) fetched; ${collected.blocked.length} blocked by SSRF policy; ${collected.failed.length} unreachable.`;
          } catch (error) {
            if (!(error instanceof ResearchUnavailableError)) throw error;
            researchNote = `External research unavailable: ${error.message}`;
          }
        }
        context = attachSources(context, sourceRecords);
        research = await runResearchAnalysis(ctx, context);
        const requireExternal = Boolean(job.configuration?.require_external_research);
        const noExternal = context.external_sources.length === 0;
        const researchRequired = noExternal && (requireExternal || research.time_sensitive || research.research_sufficiency === "insufficient");
        const researchRecord = {
          organization: article.organization, client: article.client, website: article.website, article: article.id,
          search_intent: research.search_intent, audience: research.audience, questions: research.questions,
          facts: research.required_facts, source_ids: sourceRecords.map((s) => s.id),
          existing_content_summary: research.existing_content_summary,
          internal_link_candidates: research.internal_link_candidates.map((c) => ({ ...c, ...context.internal_link_candidates.find((l) => l.id === c.candidate_id) })),
          risks: { items: research.risks, categories: research.risk_categories, claims_requiring_sources: research.claims_requiring_sources, time_sensitive: research.time_sensitive, sufficiency: research.research_sufficiency, sufficiency_reason: research.sufficiency_reason },
          do_not_claim: research.do_not_claim, content_gaps: research.content_gaps, recommended_angle: research.recommended_angle,
          research_status: researchRequired ? "research_required" : noExternal ? "limited" : "completed",
          research_notes: researchNote.slice(0, 2000), updated_at: now(),
        };
        const existingResearch = await pb.collection("article_research").getList(1, 1, { filter: `article = "${esc(article.id)}"` });
        const savedResearch = existingResearch.items[0]
          ? await pb.collection("article_research").update(existingResearch.items[0].id, researchRecord)
          : await pb.collection("article_research").create({ ...researchRecord, created_at: now() });
        if (researchRequired) {
          await saveState({ research: savedResearch.id, flags: [...new Set([...(article.flags || []), "RESEARCH_REQUIRED"])] });
          throw new PipelineStop("RESEARCH_REQUIRED", `RESEARCH_REQUIRED: ${research.sufficiency_reason || "topic needs external sources that are not available"}. Draft generation stopped; nothing was fabricated.`);
        }
        state.research = true;
        await saveState({ research: savedResearch.id, flags: noExternal ? [...new Set([...(article.flags || []), "RESEARCH_LIMITED"])] : article.flags || [] });
        await logActivity(pb, { article, action: "RESEARCH_COMPLETED", metadata: { sources: sourceRecords.length, sufficiency: research.research_sufficiency } });
      }
    }
    context = attachSources(context, sourceRecords);
    if (!research) {
      const saved = (await pb.collection("article_research").getList(1, 1, { filter: `article = "${esc(article.id)}"` })).items[0];
      if (saved) research = { search_intent: saved.search_intent, audience: saved.audience, questions: saved.questions || [], do_not_claim: saved.do_not_claim || [], recommended_angle: saved.recommended_angle, risk_categories: saved.risks?.categories || [], content_gaps: saved.content_gaps || [] };
      else research = { questions: [], do_not_claim: [], risk_categories: [] };
    }

    // ------------------------------------------------------ brief/outline/draft
    if (job.mode === "generate" || job.mode === "continue") {
      if (!state.brief) {
        await progress("building_brief");
        const brief = await runBrief(ctx, context, research);
        brief.content_type = article.content_type;
        state.brief = true;
        await saveState({ brief, status: "brief_ready", secondary_keywords: brief.secondary_keywords });
        if (job.configuration?.pause_after_brief) {
          state.paused_after_brief = true;
          await saveState();
          await updateJob(pb, job.id, { status: "completed", step: "awaiting_brief_review", progress: 30, completed_at: now() });
          return { paused: true };
        }
      }
      if (!state.outline) {
        await progress("creating_outline");
        const outline = await runOutline(ctx, context, research, article.brief);
        state.outline = true;
        await saveState({ outline, status: "outline_ready" });
      }
      if (!state.draft_version) {
        await progress("writing_draft");
        await saveState({ status: "drafting" });
        const draft = await runDraft(ctx, context, research, article.brief, article.outline);
        const cleaned = processLinks(draft.content_markdown, context, data.pages);
        const provenance = {
          generated_by: WORKER_VERSION, provider: provider.name, models: config.models, source_strategy: SOURCE_STRATEGY,
          source_strategy_version: data.opportunity?.strategy_version || data.planItem?.strategy_version || "",
          source_opportunity: article.content_opportunity || "", source_plan_item: article.content_plan_item || "",
          source_research: article.research || "", research_provider: researchProvider?.name || "none",
          generated_at: now(), content_job: job.id, auto_publish_allowed: false, writer_notes: safeText(draft.notes_for_editor, 1500),
        };
        const version = await createVersion(pb, article, { title: draft.title, content: cleaned.markdown }, { changeType: "ai_generation", reason: "Initial AI draft", label: provider.name });
        state.draft_version = version;
        await saveState({ title: safeText(draft.title, 300), content: cleaned.markdown, content_format: "markdown", status: "draft", current_version: version, provenance, qa_status: "pending", fact_check_status: "pending" });
        await logActivity(pb, { article, action: "DRAFT_GENERATED", metadata: { version, words: structureStats(cleaned.markdown, context).words } });
      }
    }

    // ------------------------------------------------------ human revision
    let autoCycles = limits.maxRevisionCycles;
    if (job.mode === "revision") {
      if (!article.content) throw new PipelineStop("NO_CONTENT", "There is no draft to revise yet.");
      await progress("revising");
      const lastQa = (await pb.collection("article_qa_reports").getList(1, 1, { filter: `article = "${esc(article.id)}"`, sort: "-created_at" })).items[0];
      const revised = await runRevision(ctx, context, { brief: article.brief, outline: article.outline, content: article.content, issues: lastQa?.issues || [], instruction: job.revision_instruction });
      const cleaned = processLinks(revised.content_markdown, context, data.pages);
      const version = await createVersion(pb, article, { title: revised.title, content: cleaned.markdown }, { changeType: "ai_revision", reason: `Human instruction: ${safeText(job.revision_instruction, 1500)}`, userId: job.triggered_by, label: provider.name });
      await saveState({ title: safeText(revised.title, 300), content: cleaned.markdown, current_version: version, status: "qa" });
    }
    if (job.mode === "recheck") autoCycles = 0;

    // ------------------------------------------------------ review loop
    let cycle = 0;
    for (;;) {
      await progress("optimizing_seo");
      await saveState({ status: "qa" });
      const content = article.content;
      const linkResult = processLinks(content, context, data.pages);
      const metadata = await runMetadata(ctx, context, content);
      const slug = sanitizeSlug(metadata.slug, article.primary_keyword);
      const metaFields = {
        seo_title: safeText(metadata.seo_title, 200), meta_description: safeText(metadata.meta_description, 400), slug,
        excerpt: safeText(metadata.excerpt, 1000), og_title: safeText(metadata.og_title, 200), og_description: safeText(metadata.og_description, 400),
      };
      const structuredData = buildStructuredData({ article, metadata: { ...metaFields }, markdown: content, context, suggestions: metadata.schema_suggestions });
      await saveState({ ...metaFields, secondary_keywords: article.secondary_keywords?.length ? article.secondary_keywords : metadata.secondary_keywords, structured_data: structuredData });
      const latestVersion = (await pb.collection("article_versions").getList(1, 1, { filter: `article = "${esc(article.id)}"`, sort: "-version" })).items[0];
      if (latestVersion && latestVersion.version === article.current_version && latestVersion.change_type !== "manual_edit" && latestVersion.change_type !== "restore") {
        await pb.collection("article_versions").update(latestVersion.id, { seo_title: metaFields.seo_title, meta_description: metaFields.meta_description, slug, excerpt: metaFields.excerpt });
      }
      await replaceForVersion(pb, "article_internal_links", article, article.current_version, [
        ...linkResult.inserted.map((l) => ({ ...l, status: "inserted" })),
        ...linkResult.recommended.map((l) => ({ ...l, status: "recommended" })),
      ]);

      await progress("checking_claims");
      const extracted = (await runClaimExtraction(ctx, context, content)).claims;
      await progress("fact_checking");
      const checked = extracted.length ? (await runFactCheck(ctx, context, extracted)).results : [];
      const evidence = evidenceIndex(context);
      const byIndex = new Map(checked.map((r) => [r.claim_index, r]));
      const claims = extracted.map((claim, index) => enforceClaim(claim, byIndex.get(index), evidence));
      const idToRecord = new Map([...context.verified_facts, ...context.external_sources, ...context.crawler_evidence, ...context.unverified_data].map((e) => [e.id, e.record_id || e.page_id || ""]));
      await replaceForVersion(pb, "article_claims", article, article.current_version, claims.map((c) => ({
        claim: c.claim, claim_type: c.claim_type, source: c.source, source_id: idToRecord.get(c.source_id) || "",
        evidence_ids: c.evidence_ids.map((id) => ({ ref: id, record: idToRecord.get(id) || "" })),
        verification_status: c.verification_status, risk_level: c.risk_level, action: c.action,
        notes: [c.notes, c.suggested_rewrite && `Suggested: ${c.suggested_rewrite}`].filter(Boolean).join(" ").slice(0, 2000),
      })));
      const claimSummary = summarizeClaims(claims);
      const specifics = scanUnsupportedSpecifics(content, context);
      const risk = detectRisk([content, context.meta.primary_keyword], [...(research.risk_categories || []), ...claims.filter((c) => ["medical", "legal", "financial"].includes(c.claim_type)).map((c) => c.claim_type)]);

      await progress("quality_review");
      const structure = structureStats(content, context);
      const duplicate = duplicateCheck(content, { pages: context.crawler_evidence.map((p) => ({ page_id: p.page_id, url: p.url, text: p.text })), articles: context.other_articles, excludePageId: article.content_type === "existing_page_optimization" ? article.existing_page : null });
      const local = localDifferentiation(content, context);
      const kw = keywordStats(content, context.meta.primary_keyword);
      const repetition = repetitionStats(content);
      const metaIssues = checkMetadata(metaFields, context);
      const deterministic = { structure, keyword: kw, repetition, duplicate, local_differentiation: local, metadata_issues: metaIssues, unsupported_specifics: specifics, claims: claimSummary, removed_links: linkResult.removed, internal_links_inserted: linkResult.inserted.length };
      const qa = await runQA(ctx, context, { brief: article.brief, content, metadata: metaFields, deterministic });
      // Deterministic issues are always included; they don't depend on the reviewer model.
      const detIssues = [
        ...specifics.map((s) => ({ severity: s.severity, check: s.code === "POSSIBLE_FAKE_QUOTE" ? "hallucination_risk" : "unsupported_claims", description: `${s.code}: ${s.value}`, fix: "Remove the specific or back it with verified/sourced evidence." })),
        ...claims.filter((c) => c.blocking || c.verification_status === "UNVERIFIED").map((c) => ({ severity: c.blocking ? "blocker" : "major", check: "unsupported_claims", description: `${c.verification_status} ${c.claim_type} claim: "${c.claim.slice(0, 200)}"`, fix: c.suggested_rewrite || (c.action === "remove" ? "Remove this claim." : "Rewrite without unsupported specifics.") })),
        ...metaIssues.map((m) => ({ severity: m.severity, check: "seo_metadata", description: m.description, fix: "Adjust metadata." })),
        ...(kw.density > 0.035 ? [{ severity: "major", check: "keyword_stuffing", description: `Primary keyword density ${(kw.density * 100).toFixed(1)}%`, fix: "Use natural variations; reduce exact-match repetition." }] : []),
        ...(duplicate.level !== "none" ? [{ severity: duplicate.level === "severe" ? "blocker" : "major", check: "duplicate_content", description: `POTENTIAL_DUPLICATE_CONTENT vs ${duplicate.top[0]?.label} (containment ${duplicate.top[0]?.containment})`, fix: "Rewrite overlapping passages with original, specific content." }] : []),
        ...(local.applicable && local.level !== "none" ? [{ severity: local.level === "severe" ? "blocker" : "major", check: "local_differentiation", description: `INSUFFICIENT_LOCAL_DIFFERENTIATION: ${local.reasons.join(" ")}`, fix: "Add genuinely location-specific evidence or keep the page generic." }] : []),
        ...(structure.languageMismatch ? [{ severity: "blocker", check: "grammar", description: `Language mismatch: expected ${structure.expectedLanguage}, detected ${structure.detectedLanguage}`, fix: `Rewrite in ${structure.expectedLanguage}.` }] : []),
        ...repetition.repeated.map((r) => ({ severity: "minor", check: "repetition", description: `Repeated sentence (${r.count}×): ${r.sentence}`, fix: "Remove repetition." })),
      ];
      const allIssues = [...qa.issues, ...detIssues];
      const verdict = computeQaStatus({ qa: { ...qa, issues: allIssues }, claimSummary, specifics, duplicate, local, structure });
      const flags = new Set((article.flags || []).filter((f) => !["POTENTIAL_DUPLICATE_CONTENT", "INSUFFICIENT_LOCAL_DIFFERENTIATION", "HIGH_RISK_REVIEW_REQUIRED", "UNSUPPORTED_BUSINESS_CLAIM", "LANGUAGE_MISMATCH"].includes(f)));
      if (duplicate.level !== "none") flags.add("POTENTIAL_DUPLICATE_CONTENT");
      if (local.applicable && local.level !== "none") flags.add("INSUFFICIENT_LOCAL_DIFFERENTIATION");
      if (risk.high_risk) flags.add("HIGH_RISK_REVIEW_REQUIRED");
      if (claims.some((c) => (c.claim_type === "business" || c.claim_type === "product") && c.verification_status === "UNVERIFIED") || specifics.some((s) => s.severity === "blocker")) flags.add("UNSUPPORTED_BUSINESS_CLAIM");
      if (structure.languageMismatch) flags.add("LANGUAGE_MISMATCH");
      const summary = [verdict.status, ...verdict.reasons, safeText(qa.summary, 1200)].filter(Boolean).join(" — ");
      await pb.collection("article_qa_reports").create({
        organization: article.organization, client: article.client, website: article.website, article: article.id,
        version: article.current_version, cycle, status: verdict.status, score: qa.score, checks: qa.checks, issues: allIssues,
        flags: [...flags], summary, created_at: now(),
      });
      await saveState({
        qa_status: verdict.status, qa_score: qa.score, qa_summary: summary, fact_check_status: claimSummary.status,
        flags: [...flags], high_risk: risk.high_risk, risk_categories: risk.categories,
        provenance: { ...(article.provenance || {}), high_risk: risk.high_risk, auto_publish_allowed: false, last_checked_at: now(), last_checked_version: article.current_version },
      });

      if (verdict.status === "PASS") {
        await saveState({ status: "awaiting_approval" });
        await logActivity(pb, { article, action: "QA_PASSED", metadata: { version: article.current_version, cycle, flags: [...flags] } });
        break;
      }
      await logActivity(pb, { article, action: "QA_FAILED", metadata: { version: article.current_version, cycle, status: verdict.status, reasons: verdict.reasons } });
      if (cycle >= autoCycles) {
        // Revision limit reached: hand to a human. BLOCKED content cannot be approved.
        await saveState({ status: verdict.status === "BLOCKED" ? "needs_revision" : "awaiting_approval" });
        break;
      }
      cycle++;
      await progress("revising");
      const required = [
        ...allIssues.filter((i) => i.severity !== "minor").slice(0, 20),
        ...claims.filter((c) => c.action === "remove" || c.action === "rewrite").map((c) => ({ severity: "claim", description: `${c.action.toUpperCase()}: "${c.claim}"`, fix: c.suggested_rewrite || "" })),
      ];
      const revised = await runRevision(ctx, context, { brief: article.brief, outline: article.outline, content, issues: required });
      const cleaned = processLinks(revised.content_markdown, context, data.pages);
      const version = await createVersion(pb, article, { title: revised.title, content: cleaned.markdown }, { changeType: "ai_revision", reason: `Automatic revision cycle ${cycle}: ${verdict.reasons.join("; ").slice(0, 1500)}`, label: provider.name });
      await saveState({ title: safeText(revised.title, 300), content: cleaned.markdown, current_version: version, revision_cycles: (article.revision_cycles || 0) + 1, status: "needs_revision" });
    }

    await updateJob(pb, job.id, { status: "completed", step: article.status === "awaiting_approval" ? "awaiting_approval" : "completed", progress: 100, completed_at: now() });
    return { article: article.id, status: article.status, qa_status: article.qa_status, budget: budget.snapshot() };
  } catch (error) {
    const code = error?.code || "ERROR";
    const message = String(error?.message || error).slice(0, 1800);
    logger.error?.(`[content-worker] job ${job.id} failed: ${code} ${message}`);
    await updateJob(pb, job.id, { status: "failed", step: "failed", error: message, error_code: code, completed_at: now() }).catch(() => {});
    if (article) {
      const fields = { pipeline_state: { ...(article.pipeline_state || {}), last_error: { code, message, job: job.id, at: now() } } };
      if (!article.content) fields.status = "failed";
      else if (["qa", "drafting"].includes(article.status)) fields.status = "draft";
      await updateArticle(pb, article.id, fields).catch(() => {});
    }
    throw error;
  }
}
