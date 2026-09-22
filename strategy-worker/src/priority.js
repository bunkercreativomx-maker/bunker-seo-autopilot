export function calculatePriority({ sourceCount = 0, businessRelevant = false, isGap = false, issueSeverity = null, cannibalization = false, hasPage = false }) {
  const evidence = Math.min(30, Math.max(0, sourceCount) * 10);
  const business = businessRelevant ? 30 : 0;
  const gap = isGap ? 20 : 0;
  const technical = ({ critical: 15, high: 12, medium: 8, low: 4, opportunity: 2 })[issueSeverity] || 0;
  const cannibal = cannibalization ? 10 : 0;
  const mapped = hasPage ? 5 : 0;
  const score = Math.min(100, evidence + business + gap + technical + cannibal + mapped);
  return {
    score,
    components: { evidence, business, gap, technical, cannibalization: cannibal, mappedPage: mapped },
    formula: "min(100, evidence + business + gap + technical + cannibalization + mappedPage)",
  };
}

// 30/60/90 scheduling is a SEPARATE concern from priority. Priority says how
// important an item is; scheduling decides WHEN it should happen. The horizon
// is driven primarily by content type and logical SEO sequence, with priority
// only breaking ties within a type. This keeps a valid strategy from dumping
// every high-priority opportunity into days 1-30 and leaving 61-90 empty.
//
//   Days 1-30  : technical fixes, cannibalization, primary commercial/service pages, critical optimization
//   Days 31-60 : secondary services, strategic location pages, commercial supporting content, internal linking
//   Days 61-90 : supporting informational content, cluster expansion, refresh/optimization, secondary opportunities
export function scheduleAction({ priority = 0, type = "", pageType = "", intent = "", isRefresh = false } = {}) {
  const p = Number(priority) || 0;
  const pt = String(pageType || "").toLowerCase();
  const t = String(type || "").toLowerCase();

  // Technical conflicts and cannibalization are immediate.
  if (t === "cannibalization" || t === "technical") return 30;

  // Internal linking happens after the primary pages exist.
  if (t === "internal_link") return 60;

  // Content creation/optimization is scheduled by content type.
  if (t === "content_gap" || t === "create" || t === "location" || t === "service" || t === "optimize" || t === "expand" || t === "refresh") {
    // Strategic location pages: mid-plan unless critical.
    if (pt === "location_page" || pt === "location") return p >= 80 ? 30 : 60;
    // Supporting informational content: later, unless unusually critical.
    if (pt === "blog_article" || pt === "article" || intent === "informational") return p >= 80 ? 30 : p >= 60 ? 60 : 90;
    // Guides / comparisons / FAQ: mid-to-late.
    if (pt === "guide" || pt === "comparison" || pt === "faq") return p >= 80 ? 30 : p >= 60 ? 60 : 90;
    // Refresh/optimization of existing pages: later.
    if (t === "refresh" || t === "optimize" || isRefresh) return p >= 80 ? 30 : p >= 60 ? 60 : 90;
    // Primary commercial/service pages.
    return p >= 70 ? 30 : p >= 45 ? 60 : 90;
  }

  return p >= 70 ? 30 : p >= 45 ? 60 : 90;
}

// Backward-compatible wrapper (priority + type only).
export function planHorizon(priority, type) {
  return scheduleAction({ priority, type });
}
