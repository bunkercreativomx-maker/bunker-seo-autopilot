import { DEFAULT_COLLECTIONS } from "./pb.js";

const priorityName = (score) => score >= 80 ? "critical" : score >= 60 ? "high" : score >= 40 ? "medium" : "low";
const pageType = (type, mapped = false) => mapped ? "existing_page" : ({ service: "service_page", location: "location_page", article: "blog_article", product: "product_page", utility: "other" }[type] || "other");
const funnelStage = (intent) => ({ informational: "awareness", commercial: "consideration", transactional: "conversion", navigational: "consideration" }[intent] || "unknown");
const manual = (record) => record.manual_override ? {
  manual_override: true, manual_fields: record.manual_fields || [], overridden_by: record.overridden_by || undefined, overridden_at: record.overridden_at || undefined,
} : { manual_override: false, manual_fields: [] };
function preservePayload(payload, previous) {
  if (!previous?.manual_override) return payload;
  const result = { ...payload };
  for (const field of previous.manual_fields || []) if (field in previous) result[field] = previous[field];
  return { ...result, ...manual(previous) };
}
const tenant = (ctx, versionId, now) => ({ organization: ctx.organization.id, client: ctx.client.id, website: ctx.website.id, strategy_version: versionId, created_at: now, updated_at: now });

function keywordSource(record) {
  if (record.source_types.includes("ai_discovery")) return "ai_discovery";
  if (record.source_types.includes("business_combination")) return "locations";
  if (record.source_types.includes("client") || record.source_types.includes("business_fact")) return "services";
  return "existing_page_content";
}

export async function persistStrategy(pb, strategy, context, collections = DEFAULT_COLLECTIONS, now = new Date().toISOString()) {
  const base = { organization: context.organization.id, client: context.client.id, website: context.website.id };
  const version = await pb.collection(collections.versions).create({
    ...base, strategy_job: context.job?.id || undefined, version: strategy.version,
    summary: `${strategy.keywords.length} keywords, ${strategy.clusters.length} clusters, ${strategy.gaps.length} gaps`,
    generated_at: now, generated_by: context.job?.triggered_by || undefined,
    configuration: { engine_version: strategy.engine_version, provenance: strategy.provenance }, created_at: now, updated_at: now,
  });
  const t = tenant(context, version.id, now);
  const ids = { keywords: new Map(), clusters: new Map(), opportunities: new Map() };
  const counts = { keywords: 0, clusters: 0, mappings: 0, opportunities: 0, cannibalization: 0, actions: 0 };

  try {
    for (const item of strategy.keywords) {
      const created = await pb.collection(collections.keywords).create({
        ...t, keyword: item.keyword, normalized_keyword: item.normalized_keyword,
        language: context.client.primary_language || context.website.primary_language || "und",
        country: context.website.country || context.client.country || "", target_location: null,
        intent: item.intent, intent_confidence: item.mapping_score ?? 1, funnel_stage: funnelStage(item.intent), topic: item.cluster,
        source: keywordSource(item), source_query: item.sources[0]?.value || item.keyword,
        existing_target_page: item.existing_page_id || undefined,
        recommended_target_page: item.existing_page_url || "",
        opportunity_type: item.existing_page_id ? (item.competing_page_ids.length ? "merge" : "optimize") : "create",
        recommended_page_type: item.recommended_page_type || pageType(item.page_type, Boolean(item.existing_page_id)),
        priority: item.priority || priorityName(item.priority_score), status: item.status || "discovered",
        search_volume: null, cpc: null, keyword_difficulty: null, metrics_source: "", metrics_updated_at: null,
        confidence: item.mapping_score ?? 1, evidence: { stable_key: item.key, sources: item.sources, priority: item.priority_breakdown }, ...manual(item),
      });
      ids.keywords.set(item.id, created.id); counts.keywords++;
    }

    for (const item of strategy.clusters) {
      const pillarKeyword = item.keyword_ids.map((id) => ids.keywords.get(id)).find(Boolean);
      const created = await pb.collection(collections.clusters).create({
        ...t, name: item.name, description: item.description || `Deterministic cluster derived from declared services and observed page language.`,
        primary_topic: item.primary_topic || item.name, pillar_keyword: item.pillar_keyword || pillarKeyword || undefined, pillar_page: item.pillar_page || item.pillar_page_id || undefined,
        status: item.status || "draft", confidence: item.confidence ?? 1, evidence: { stable_key: item.key, ...item.evidence }, ...manual(item),
      });
      ids.clusters.set(item.key, created.id); counts.clusters++;
    }

    for (const item of strategy.keywords) {
      const keywordId = ids.keywords.get(item.id);
      const clusterId = ids.clusters.get(item.cluster_key);
      if (clusterId) await pb.collection(collections.keywords).update(keywordId, { cluster: clusterId, updated_at: now });
      const mappingPayload = {
        ...t, keyword: keywordId, current_page: item.existing_page_id || undefined,
        recommended_page: item.existing_page_url || `/${item.key}`,
        mapping_type: item.existing_page_id ? "existing_target" : (item.page_type === "location" ? "new_location_page" : item.page_type === "article" ? "new_blog_post" : "new_service_page"),
        confidence: item.mapping_score ?? 1,
        reason: item.existing_page_id ? "Observed title, H1, or URL tokens match this keyword." : "No matching indexable crawler page was observed.",
        evidence: { stable_key: item.key, mapping_score: item.mapping_score }, status: "proposed", ...manual(item),
      };
      const priorMapping = context.existing?.mappings?.find((record) => record.key === item.key);
      await pb.collection(collections.mappings).create(preservePayload(mappingPayload, priorMapping));
      counts.mappings++;
    }

    for (const item of strategy.gaps) {
      const keyword = strategy.keywords.find((entry) => entry.key === item.key.split(":").at(-1));
      const created = await pb.collection(collections.opportunities).create({
        ...t, keyword: keyword ? ids.keywords.get(keyword.id) : undefined, cluster: keyword ? ids.clusters.get(keyword.cluster_key) : undefined,
        opportunity_type: item.opportunity_type || (item.gap_type === "service_location" ? "location" : "create"),
        recommended_page_type: item.recommended_page_type || (item.gap_type === "service_location" ? "location_page" : "service_page"),
        existing_page: item.existing_page || undefined,
        recommended_url: item.recommended_url || `/${item.keyword.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")}`,
        title_suggestion: item.title_suggestion || item.keyword, reason: item.reason || "Declared business service/location has no matching indexable crawler page.",
        priority: item.priority || priorityName(item.priority_score), status: item.status || "proposed", confidence: item.confidence ?? 1,
        evidence: { stable_key: item.key, inputs: item.evidence, priority: item.priority_breakdown }, ...manual(item),
      });
      ids.opportunities.set(item.id, created.id); counts.opportunities++;
    }

    for (const item of strategy.internal_links) {
      const created = await pb.collection(collections.opportunities).create({
        ...t, cluster: ids.clusters.get(item.cluster_key), opportunity_type: "internal_link", recommended_page_type: "existing_page",
        existing_page: item.source_page_id, recommended_url: item.destination_url,
        title_suggestion: item.suggested_anchor, reason: "Pages share a deterministic topic cluster and no existing edge was observed.",
        priority: priorityName(55), status: item.status || "proposed", confidence: 1,
        evidence: { stable_key: item.key, destination_page_id: item.destination_page_id, ...item.evidence }, ...manual(item),
      });
      ids.opportunities.set(item.id, created.id); counts.opportunities++;
    }

    for (const item of strategy.cannibalization) {
      await pb.collection(collections.cannibalization).create({
        ...t, keyword_group: item.keyword, pages: item.page_ids,
        reason: item.reason || "Multiple indexable pages meet the documented token-overlap threshold for the same keyword.",
        severity: item.severity || (item.priority_score >= 70 ? "high" : item.priority_score >= 45 ? "medium" : "low"),
        recommended_action: item.recommended_action || "Select one primary page; consolidate, differentiate, redirect, or canonicalize competing pages after human review.",
        status: item.status || "open", confidence: item.confidence ?? 1, evidence: { stable_key: item.key, ...item.evidence, priority: item.priority_breakdown }, ...manual(item),
      });
      counts.cannibalization++;
    }

    const planPayload = { ...t, name: "90-day SEO roadmap", period: "30_60_90", status: "draft", manual_override: false, manual_fields: [] };
    const plan = await pb.collection(collections.plans).create(preservePayload(planPayload, context.existing?.plans?.[0]));
    for (const days of [30, 60, 90]) for (const item of strategy.plan[days]) {
      const action = item.action || (item.type === "internal_link" ? "add_internal_links" : item.type === "cannibalization" ? "merge_content" : "create_new_page");
      await pb.collection(collections.actions).create({
        ...t, plan: plan.id, opportunity: ids.opportunities.get(item.entity_id), action,
        page_type: item.page_type || (item.type === "internal_link" ? "existing_page" : "other"), existing_page: item.existing_page || undefined,
        proposed_url: item.proposed_url || "", proposed_title: item.proposed_title || item.title, priority: item.priority || priorityName(item.priority_score),
        scheduled_period: days === 30 ? "days_1_30" : days === 60 ? "days_31_60" : "days_61_90",
        status: item.status || "planned", reason: item.reason || `Scheduled by transparent priority score ${item.priority_score}.`,
        evidence: { stable_key: item.key, priority: item.priority_breakdown }, ...manual(item),
      });
      counts.actions++;
    }
    return { version, counts };
  } catch (error) {
    await pb.collection(collections.versions).delete(version.id).catch(() => {});
    throw error;
  }
}

export async function recordAIUsage(pb, usage, context, collections = DEFAULT_COLLECTIONS) {
  if (!usage || Number(usage.calls) === 0) return null;
  const now = new Date().toISOString();
  return pb.collection(collections.ai_usage).create({
    organization: context.organization.id, client: context.client.id, website: context.website.id,
    job: context.job?.id || undefined, strategy_version: context.strategyVersionId || context.savedVersionId || undefined,
    task: usage.task || "keyword_discovery", provider: usage.provider, model: usage.model || "unknown",
    input_tokens: usage.inputTokens || 0, output_tokens: usage.outputTokens || 0, estimated_cost: usage.estimatedCost || 0,
    timestamp: now, created_at: now, updated_at: now,
  });
}
