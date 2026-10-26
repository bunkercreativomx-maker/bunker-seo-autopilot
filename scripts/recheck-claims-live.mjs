// Re-run the REAL fact checker (AI) + deterministic gate on stored claims of
// articles, without touching PocketBase. For audits / before-after tests.
// Usage: OPENAI_API_KEY=... node scripts/recheck-claims-live.mjs <audit_input.json> <out.json> [articleId ...]
import { readFileSync, writeFileSync } from "node:fs";
import { createAIProvider } from "../content-worker/src/ai-provider.js";
import { runFactCheck } from "../content-worker/src/stages.js";
import { enforceClaim } from "../content-worker/src/checks.js";
import { loadPageTexts } from "../content-worker/src/pipeline.js";
const pageCache = new Map();
async function sitePages(a) {
  const key = `${a.website}|${a.title}`;
  if (pageCache.has(key)) return pageCache.get(key);
  const pages = (data.pages?.[a.website] || []);
  const texts = await loadPageTexts({ pages, website: { domain: data.domains?.[a.website] }, article: { existing_page: "" } }, { primaryKeyword: a.title, limit: 6 });
  const ev = pages.filter((p) => texts.has(p.id)).map((p, i) => ({ id: `C${i + 1}`, page_id: p.id, url: p.url, title: p.title, h1: p.h1, meta_description: p.meta_description, headings: (Array.isArray(p.headings) ? p.headings : []).slice(0, 25).map((h) => (typeof h === "string" ? h : h.text || "")), text: String(texts.get(p.id)).slice(0, 5000) }));
  pageCache.set(key, ev);
  return ev;
}

const [, , input, output, ...only] = process.argv;
const data = JSON.parse(readFileSync(input, "utf8"));
const provider = createAIProvider({ provider: "openai", apiKey: process.env.OPENAI_API_KEY, baseUrl: "https://api.openai.com/v1", pricing: {} });
const ctx = {
  provider,
  config: { models: { fact_check: process.env.FACT_MODEL || "gpt-5-mini" }, retries: 1, timeoutMs: 240000, maxOutputTokens: 32000 },
  budget: { assertCanCall() {}, record() {} },
};
const out = [];
const STATUSES = (process.env.STATUSES || "").split(",").filter(Boolean);
const todo = data.articles.filter((a) => (!only.length || only.includes(a.id)) && (!STATUSES.length || STATUSES.includes(a.status)));
async function one(a) {
  const facts = (data.facts[a.website] || []).map((f, i) => ({ id: `F${i + 1}`, type: f.type, label: f.label, value: f.value, source: "verified", record_id: f.id }));
  const domain = String(a.domain || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  const crawler = await sitePages(a);
  const context = { meta: { business_name: a.site, website_domain: domain, language: "auto" }, verified_facts: facts, unverified_data: [], crawler_evidence: crawler, external_sources: [], ai_inferences: [] };
  const evidence = new Map([...facts.map((f) => [f.id, { category: "verified_fact", item: f }]), ...crawler.map((c) => [c.id, { category: "crawler", item: c }])]);
  const brandTerms = [a.site, domain.split(".")[0]].filter(Boolean);
  const claims = a.claims.filter((c) => ["business", "product"].includes(c.claim_type)).map((c) => ({ claim: c.claim, claim_type: c.claim_type, business_specific: true, sensitive_topic: "none" }));
  const results = [];
  for (let i = 0; i < claims.length; i += 30) {
    const batch = claims.slice(i, i + 30);
    const checked = (await runFactCheck(ctx, context, batch)).results;
    const byIndex = new Map(checked.map((r) => [r.claim_index, r]));
    batch.forEach((c, j) => {
      const r = enforceClaim(c, byIndex.get(j), evidence, { brandTerms, ownDomain: domain });
      results.push({ ai_status: byIndex.get(j)?.verification_status, claim: c.claim, before: a.claims.find((x) => x.claim === c.claim)?.status, after: r.verification_status, notes: r.notes.slice(0, 300), details: byIndex.get(j)?.details || [] });
    });
  }
  out.push({ id: a.id, title: a.title, site: a.site, status: a.status, pages: crawler.length, crawler, results });
  console.log(`${a.site} | ${a.title.slice(0, 50)} | business claims ${results.length} | now unverified ${results.filter((r) => r.after !== "VERIFIED").length}`);
}
const queue = [...todo];
await Promise.all(Array.from({ length: Number(process.env.CONCURRENCY || 6) }, async () => {
  while (queue.length) { const a = queue.shift(); try { await one(a); } catch (e) { console.log(`ERROR ${a.id} ${e.message}`); } }
}));
writeFileSync(output, JSON.stringify(out, null, 2));
