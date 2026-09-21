import { classifyIntent, inferPageType } from "./classify.js";
import { calculatePriority, planHorizon } from "./priority.js";
import { keywordKey, normalizeKeyword, overlapScore, pagePhrases, safeText, splitBusinessValues } from "./normalize.js";

const SEVERITY_RANK = { critical: 5, high: 4, medium: 3, low: 2, opportunity: 1 };
const MANUAL_FIELDS = ["keyword", "intent", "page_type", "target_page", "cluster", "priority", "status", "notes", "assignee", "due_date"];

function stableId(prefix, value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}_${(hash >>> 0).toString(36)}`;
}

function sourceRef(type, record, field) {
  return { type, id: record?.id || null, field, value: safeText(record?.[field], 300) };
}

function addCandidate(map, phrase, source, extra = {}) {
  const normalized = normalizeKeyword(phrase);
  if (normalized.length < 3) return;
  const key = keywordKey(normalized);
  const current = map.get(key) || {
    id: stableId("kw", key),
    key,
    keyword: safeText(phrase, 120),
    normalized_keyword: normalized,
    sources: [],
    business_relevant: false,
    source_types: [],
  };
  const sourceKey = `${source.type}:${source.id || ""}:${source.field}:${normalizeKeyword(source.value)}`;
  if (!current.sources.some((item) => item.key === sourceKey)) current.sources.push({ ...source, key: sourceKey });
  current.business_relevant ||= Boolean(extra.businessRelevant);
  current.source_types = [...new Set([...current.source_types, source.type])].sort();
  map.set(key, current);
}

function pageSearchText(page) {
  return [page.title, page.h1, page.path, page.url].map((value) => safeText(value, 500)).join(" ");
}

function mapPages(keyword, pages, minimumScore = 0.6) {
  return pages
    .filter((page) => page.indexable !== false && Number(page.status_code || 200) < 400)
    .map((page) => {
      const exactTitle = normalizeKeyword(page.title) === normalizeKeyword(keyword) ? 1 : 0;
      const exactH1 = normalizeKeyword(page.h1) === normalizeKeyword(keyword) ? 1 : 0;
      return { page, score: overlapScore(keyword, pageSearchText(page)), exact: exactTitle + exactH1 };
    })
    .filter((entry) => entry.score >= minimumScore)
    .sort((a, b) => b.score - a.score || b.exact - a.exact || Number(b.page.word_count || 0) - Number(a.page.word_count || 0) || String(a.page.url).localeCompare(String(b.page.url)));
}

function clusterLabel(keyword, services) {
  const matching = services
    .map((service) => ({ service, score: overlapScore(keyword, service) }))
    .filter((entry) => entry.score >= 0.5)
    .sort((a, b) => b.score - a.score || a.service.localeCompare(b.service));
  if (matching.length) return matching[0].service;
  return normalizeKeyword(keyword).split(" ").slice(0, 2).join(" ");
}

function highestPageSeverity(pageId, issues) {
  return issues
    .filter((issue) => issue.status !== "resolved" && (issue.page === pageId || issue.page_id === pageId))
    .sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0))[0]?.severity || null;
}

function makeGap({ type, keyword, service, location, keywords, pages }) {
  const key = `${type}:${keywordKey(keyword)}`;
  const related = keywords.find((item) => item.key === keywordKey(keyword));
  const mapped = related?.existing_page_id || null;
  if (mapped) return null;
  const evidence = [service && { field: "services", value: service }, location && { field: "location", value: location }].filter(Boolean);
  const priority = calculatePriority({ sourceCount: evidence.length, businessRelevant: true, isGap: true, hasPage: false });
  return {
    id: stableId("gap", key), key, gap_type: type, keyword, service: service || null, location: location || null,
    evidence, mapped_page_id: null, mapped_page_url: null, observed_page_count: pages.length,
    search_volume: null, keyword_difficulty: null, cpc: null, metrics_source: null,
    priority_score: priority.score, priority_breakdown: priority,
  };
}

export function mergeManualOverrides(generated, existing) {
  if (!existing) return generated;
  const result = { ...generated };
  const overrides = existing.manual_overrides && typeof existing.manual_overrides === "object" ? existing.manual_overrides : {};
  for (const [field, value] of Object.entries(overrides)) result[field] = value;
  const manualFields = Array.isArray(existing.manual_fields) ? existing.manual_fields : [];
  for (const field of manualFields) if (field in existing) result[field] = existing[field];
  for (const field of MANUAL_FIELDS) {
    if (existing[`${field}_manual`] === true) result[field] = existing[field];
  }
  result.manual_overrides = { ...overrides };
  result.manual_override = Boolean(existing.manual_override || Object.keys(overrides).length || manualFields.length);
  result.manual_fields = [...new Set([...manualFields, ...Object.keys(overrides)])];
  if (existing.overridden_by) result.overridden_by = existing.overridden_by;
  if (existing.overridden_at) result.overridden_at = existing.overridden_at;
  if (existing.id) result.previous_record_id = existing.id;
  return result;
}

export function mergeGeneratedRecords(generated, existing = []) {
  const byKey = new Map(existing.map((record) => [record.key || record.stable_key, record]));
  return generated.map((record) => mergeManualOverrides(record, byKey.get(record.key)));
}

export function buildStrategy(input) {
  const client = input?.client || {};
  const website = input?.website || {};
  const pages = [...(input?.pages || [])].sort((a, b) => String(a.url).localeCompare(String(b.url)));
  const links = input?.links || [];
  const issues = input?.issues || [];
  const facts = input?.facts || [];
  const factServices = facts.filter((fact) => fact.fact_type === "service" || fact.fact_type === "product").flatMap((fact) => splitBusinessValues(fact.value));
  const services = [...new Map([...splitBusinessValues(client.services), ...splitBusinessValues(client.products), ...factServices].map((value) => [normalizeKeyword(value), value])).values()];
  const locations = [...new Set([
    ...splitBusinessValues(client.primary_location), ...splitBusinessValues(client.service_areas),
    ...splitBusinessValues(website.target_locations), ...splitBusinessValues(website.country),
    ...facts.filter((fact) => fact.fact_type === "location" || fact.fact_type === "service_area").flatMap((fact) => splitBusinessValues(fact.value)),
  ].map(normalizeKeyword).filter(Boolean))];
  const candidates = new Map();
  const limits = {
    maxKeywords: Math.max(1, Number(input?.limits?.maxKeywords ?? 200)),
    maxClusters: Math.max(1, Number(input?.limits?.maxClusters ?? 50)),
    maxOpportunities: Math.max(0, Number(input?.limits?.maxOpportunities ?? 100)),
  };

  for (const service of services) addCandidate(candidates, service, sourceRef("client", client, client.services?.includes?.(service) ? "services" : "products"), { businessRelevant: true });
  for (const fact of facts.filter((item) => item.fact_type === "service" || item.fact_type === "product")) {
    for (const value of splitBusinessValues(fact.value)) addCandidate(candidates, value, sourceRef("business_fact", fact, "value"), { businessRelevant: true });
  }
  for (const page of pages) {
    for (const phrase of pagePhrases(page, client.business_name)) {
      const field = normalizeKeyword(page.h1) === normalizeKeyword(phrase) ? "h1" : normalizeKeyword(page.title) === normalizeKeyword(phrase) ? "title" : "path";
      addCandidate(candidates, phrase, sourceRef("page", page, field), { businessRelevant: services.some((service) => overlapScore(service, phrase) >= 0.5) });
    }
  }
  for (const service of services) for (const location of locations) {
    const phrase = `${service} ${location}`;
    addCandidate(candidates, phrase, { type: "business_combination", id: client.id || null, field: "services+locations", value: phrase }, { businessRelevant: true });
  }
  for (const candidate of input?.ai_candidates || []) {
    for (const evidence of candidate.sources || []) {
      addCandidate(candidates, candidate.keyword, evidence, { businessRelevant: true });
    }
  }

  let keywords = [...candidates.values()].map((candidate) => {
    // A service+location gap is covered only when the page contains essentially
    // the whole phrase; a generic service page must not mask a local gap.
    const minimumMappingScore = candidate.source_types.includes("business_combination") ? 0.95 : 0.6;
    const matches = mapPages(candidate.keyword, pages, minimumMappingScore);
    const mapped = matches[0]?.page;
    const cluster = clusterLabel(candidate.keyword, services);
    const severity = mapped ? highestPageSeverity(mapped.id, issues) : null;
    const priority = calculatePriority({
      sourceCount: candidate.sources.length, businessRelevant: candidate.business_relevant,
      isGap: !mapped, issueSeverity: severity, cannibalization: matches.length > 1, hasPage: Boolean(mapped),
    });
    return {
      ...candidate,
      sources: candidate.sources.map((source) => Object.fromEntries(Object.entries(source).filter(([field]) => field !== "key"))),
      intent: classifyIntent(candidate.keyword), page_type: inferPageType(candidate.keyword, mapped || {}),
      cluster_key: keywordKey(cluster), cluster,
      existing_page_id: mapped?.id || null, existing_page_url: mapped?.url || null,
      mapping_score: matches[0]?.score ?? null, mapping_threshold: minimumMappingScore,
      competing_page_ids: matches.slice(1).map((entry) => entry.page.id),
      search_volume: null, keyword_difficulty: null, cpc: null, metrics_source: null,
      priority_score: priority.score, priority_breakdown: priority,
    };
  }).sort((a, b) => b.priority_score - a.priority_score || a.normalized_keyword.localeCompare(b.normalized_keyword))
    .slice(0, limits.maxKeywords);

  keywords = mergeGeneratedRecords(keywords, input?.existing?.keywords);

  const groupedKeywords = new Map();
  for (const keyword of keywords) {
    const members = groupedKeywords.get(keyword.cluster_key) || [];
    members.push(keyword);
    groupedKeywords.set(keyword.cluster_key, members);
  }
  let clusters = [...groupedKeywords].map(([key, members]) => {
    const label = members[0].cluster;
    const mapped = [...new Set(members.map((item) => item.existing_page_id).filter(Boolean))];
    return {
      id: stableId("cluster", key), key, name: label, keyword_ids: members.map((item) => item.id).sort(),
      keyword_count: members.length, mapped_page_ids: mapped, pillar_page_id: mapped[0] || null,
      evidence: { derived_from: "normalized keyword overlap with declared services", source_keyword_ids: members.map((item) => item.id).sort() },
    };
  }).sort((a, b) => b.keyword_count - a.keyword_count || a.key.localeCompare(b.key))
    .slice(0, limits.maxClusters);
  const allowedClusters = new Set(clusters.map((cluster) => cluster.key));
  keywords = keywords.filter((keyword) => allowedClusters.has(keyword.cluster_key));

  const gaps = [];
  for (const service of services) {
    const gap = makeGap({ type: "service", keyword: service, service, keywords, pages });
    if (gap) gaps.push(gap);
    for (const location of locations) {
      const localGap = makeGap({ type: "service_location", keyword: `${service} ${location}`, service, location, keywords, pages });
      if (localGap) gaps.push(localGap);
    }
  }
  gaps.sort((a, b) => b.priority_score - a.priority_score || a.key.localeCompare(b.key));

  const cannibalization = keywords.filter((item) => item.competing_page_ids.length).map((item) => {
    const pageIds = [item.existing_page_id, ...item.competing_page_ids].filter(Boolean);
    const priority = calculatePriority({ sourceCount: item.sources.length, businessRelevant: item.business_relevant, cannibalization: true, hasPage: true });
    return {
      id: stableId("can", item.key), key: item.key, keyword_id: item.id, keyword: item.keyword,
      page_ids: pageIds, evidence: { rule: `token overlap >= ${item.mapping_threshold.toFixed(2)}`, mapping_threshold: item.mapping_threshold, page_count: pageIds.length },
      priority_score: priority.score, priority_breakdown: priority,
    };
  });

  const edgeKeys = new Set(links.map((link) => `${link.source_page || link.source_page_id}->${link.destination_page || link.destination_page_id || ""}`));
  const internalLinks = [];
  for (const cluster of clusters) {
    const clusterPages = pages.filter((page) => cluster.mapped_page_ids.includes(page.id));
    const target = clusterPages.sort((a, b) => Number(b.word_count || 0) - Number(a.word_count || 0) || String(a.url).localeCompare(String(b.url)))[0];
    if (!target) continue;
    for (const source of pages.filter((page) => page.id !== target.id && overlapScore(pageSearchText(page), cluster.name) >= 0.4)) {
      const edge = `${source.id}->${target.id}`;
      if (edgeKeys.has(edge)) continue;
      const key = `${source.id}:${target.id}:${cluster.key}`;
      internalLinks.push({
        id: stableId("link", key), key, source_page_id: source.id, source_url: source.url,
        destination_page_id: target.id, destination_url: target.url, suggested_anchor: cluster.name,
        cluster_key: cluster.key, evidence: { rule: "shared cluster with no observed existing link", observed_existing_link: false },
      });
    }
  }

  const boundedGaps = gaps.slice(0, limits.maxOpportunities);
  const boundedInternalLinks = internalLinks.slice(0, Math.max(0, limits.maxOpportunities - boundedGaps.length));

  const generatedActions = [
    ...boundedGaps.map((gap) => ({ key: `gap:${gap.key}`, type: "content_gap", title: `Create or improve a ${gap.gap_type.replace("_", " ")} page for “${gap.keyword}”`, entity_id: gap.id, priority_score: gap.priority_score, priority_breakdown: gap.priority_breakdown })),
    ...cannibalization.map((item) => ({ key: `cannibalization:${item.key}`, type: "cannibalization", title: `Resolve competing pages for “${item.keyword}”`, entity_id: item.id, priority_score: item.priority_score, priority_breakdown: item.priority_breakdown })),
    ...boundedInternalLinks.map((item) => {
      const priority = calculatePriority({ sourceCount: 2, businessRelevant: true, hasPage: true });
      return { key: `internal-link:${item.key}`, type: "internal_link", title: `Link ${item.source_url} to ${item.destination_url}`, entity_id: item.id, priority_score: priority.score, priority_breakdown: priority };
    }),
  ].map((action) => ({ ...action, id: stableId("action", action.key), horizon_days: planHorizon(action.priority_score, action.type) }))
    .sort((a, b) => a.horizon_days - b.horizon_days || b.priority_score - a.priority_score || a.key.localeCompare(b.key));
  const actions = mergeGeneratedRecords(generatedActions, input?.existing?.actions);

  const previousVersion = Math.max(0, Number(input?.previous_version) || 0);
  return {
    version: previousVersion + 1,
    engine_version: "1.0.0-deterministic",
    provenance: {
      client_id: client.id || null, website_id: website.id || null,
      page_count: pages.length, link_count: links.length, issue_count: issues.length,
      inputs: ["clients", "websites", "business_facts", "website_pages", "page_links", "seo_issues"],
      fabricated_metrics: false, ai_provider: input?.ai?.provider || "null", ai_calls: Number(input?.ai?.calls) || 0,
    },
    keywords,
    clusters: mergeGeneratedRecords(clusters, input?.existing?.clusters),
    gaps: mergeGeneratedRecords(boundedGaps, input?.existing?.gaps),
    cannibalization: mergeGeneratedRecords(cannibalization, input?.existing?.cannibalization),
    internal_links: mergeGeneratedRecords(boundedInternalLinks, input?.existing?.internal_links),
    plan: { 30: actions.filter((item) => item.horizon_days === 30), 60: actions.filter((item) => item.horizon_days === 60), 90: actions.filter((item) => item.horizon_days === 90) },
  };
}
