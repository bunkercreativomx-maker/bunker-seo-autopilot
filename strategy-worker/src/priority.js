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

export function planHorizon(priority, type) {
  if (type === "cannibalization" || type === "technical" || priority >= 70) return 30;
  if (priority >= 45) return 60;
  return 90;
}
