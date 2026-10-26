// Re-apply the deterministic gate to cached AI fact-check output (no AI cost).
// Usage: node scripts/regate-cached.mjs <audit_input.json> <recheck_out.json>
import { readFileSync } from "node:fs";
import { enforceClaim } from "../content-worker/src/checks.js";
const [, , input, cached] = process.argv;
const data = JSON.parse(readFileSync(input, "utf8"));
for (const art of JSON.parse(readFileSync(cached, "utf8"))) {
  const a = data.articles.find((x) => x.id === art.id);
  const facts = (data.facts[a.website] || []).map((f, i) => ({ id: `F${i + 1}`, type: f.type, label: f.label, value: f.value }));
  const evidence = new Map([...facts.map((f) => [f.id, { category: "verified_fact", item: f }]), ...(art.crawler || []).map((c) => [c.id, { category: "crawler", item: c }])]);
  const domain = String(data.domains?.[a.website] || a.domain || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  const brandTerms = [a.site, domain.split(".")[0]].filter(Boolean);
  console.log(`## ${art.site} | ${art.title}`);
  for (const r of art.results) {
    const proposal = { verification_status: r.ai_status || "VERIFIED", evidence_ids: [], details: r.details };
    const out = enforceClaim({ claim: r.claim, claim_type: r.claim_type || "product", sensitive_topic: "none" }, proposal, evidence, { brandTerms, ownDomain: domain });
    if (!process.env.ONLY_BAD || !["VERIFIED","NOT_REQUIRED","SUPPORTED"].includes(out.verification_status)) console.log(`${out.verification_status.padEnd(12)} ${r.claim.slice(0, 120)}${out.verification_status !== "VERIFIED" ? `\n    ↳ ${out.notes.match(/Detail not stated[^.]*\.|Contradicts[^.]*/)?.[0] || ""}` : ""}`);
  }
}
