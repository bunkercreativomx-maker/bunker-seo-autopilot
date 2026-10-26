// Labels for the post structures chosen by the content worker
// (content-worker/src/formats.js POST_FORMATS — keep keys in sync).
export const POST_FORMAT_LABELS: Record<string, string> = {
  problem_solution: "Problem → Solution",
  signs_list: "Warning-signs checklist",
  cost_guide: "Honest cost guide",
  comparison: "Fair comparison",
  faq: "Real questions answered",
  how_to: "Step-by-step guide",
  aida: "AIDA",
  aida_service: "Service page (AIDA)",
};

export function postFormatLabel(brief: unknown, provenance: unknown): string {
  const pick = (v: unknown) => (v && typeof v === "object" ? String((v as { post_format?: unknown }).post_format || "") : "");
  const key = pick(brief) || pick(provenance);
  return POST_FORMAT_LABELS[key] || "";
}
