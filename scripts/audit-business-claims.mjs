// Offline audit: re-runs the deterministic business-claim gate over stored
// claims of every article. No AI, no writes. Input: JSON dump
// { facts: {websiteId: [{type,label,value}]}, articles: [{id,title,status,site,domain,content,claims:[{claim,claim_type,status}]}] }
// Usage: node scripts/audit-business-claims.mjs <input.json> <output.json>
import { readFileSync, writeFileSync } from "node:fs";
import { enforceClaim } from "../content-worker/src/checks.js";
import { normalizeForMatch } from "../content-worker/src/text.js";

const [, , input, output] = process.argv;
const data = JSON.parse(readFileSync(input, "utf8"));
const report = [];
for (const a of data.articles) {
  const siteFacts = Object.entries(data.facts).find(([wid]) => a.website === wid)?.[1] || data.facts[a.website_id] || [];
  const facts = data.facts[a.website] || siteFacts;
  const evidence = new Map(facts.map((f, i) => [`F${i + 1}`, { category: "verified_fact", item: f }]));
  const domain = String(a.domain || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  const brandTerms = [a.site, domain.split(".")[0]].filter(Boolean);
  const content = normalizeForMatch(a.content);
  const flagged = [];
  for (const c of a.claims) {
    const r = enforceClaim({ claim: c.claim, claim_type: c.claim_type, sensitive_topic: c.sensitive_topic || "none" }, { verification_status: c.status === "VERIFIED" ? "VERIFIED" : c.status, evidence_ids: [] }, evidence, { brandTerms, ownDomain: domain });
    const isBiz = ["business", "product"].includes(c.claim_type) || r.source === "verified_business_fact" || /UNVERIFIED|CONTRADICTED/.test(r.verification_status) && c.status === "VERIFIED";
    if (!isBiz) continue;
    if (r.verification_status === "UNVERIFIED" || r.verification_status === "CONTRADICTED") {
      // still in the live copy? (cheap check: 6 consecutive words)
      const words = normalizeForMatch(c.claim).split(" ").filter((w) => w.length > 2);
      let inCopy = false;
      for (let i = 0; i + 5 <= words.length && !inCopy; i++) if (content.includes(words.slice(i, i + 5).join(" "))) inCopy = true;
      flagged.push({ claim: c.claim, before: c.status, after: r.verification_status, in_copy: inCopy, notes: r.notes.slice(0, 200) });
    }
  }
  report.push({ id: a.id, title: a.title, status: a.status, site: a.site, flagged });
}
writeFileSync(output, JSON.stringify(report, null, 2));
const tot = report.reduce((n, r) => n + r.flagged.length, 0);
console.log(`articles ${report.length} flagged claims ${tot}`);
