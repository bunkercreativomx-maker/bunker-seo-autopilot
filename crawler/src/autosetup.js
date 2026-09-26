// Persist the auto-setup profile learned from the website (see profile.js).
// Rules:
//  - Client/website fields are only FILLED when empty; anything a person typed
//    is never overwritten.
//  - Facts are grounded: each one has a word-for-word quote found on the
//    client's own site (checked by code) + the page URL. Those are stored as
//    provenance "website", verification_state "verified" (source = the client's
//    own published site), EXCEPT prices and promotions, which change often and
//    stay "unverified" so articles never state them.
//  - Existing facts are never modified; duplicates are skipped.
//  - When done, a strategy job is queued so topics are ready without clicks.
import { buildProfile, normalizeText } from "./profile.js";
import { renderKeyPages, visibleWords } from "./render.js";

const NEVER_AUTO_VERIFY = new Set(["price", "promotion"]);

function isEmpty(v) {
  return v === undefined || v === null || String(v).replace(/<[^>]*>/g, "").trim() === "";
}

function looksLikeDomain(v) {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(v || "").trim());
}

export async function applyAutoSetup(pb, ctx, job, pages, { ai = null, render = null, now = () => new Date().toISOString(), logger = console } = {}) {
  // JavaScript-only sites (React/Vite, Wix…) come back almost empty from a plain
  // fetch: render the key pages in a real browser (Firecrawl) instead.
  let source = pages;
  let rendered = false;
  if (visibleWords(pages) < 150 && render?.apiKey) {
    try {
      const origin = `https://${String(ctx.website.domain).replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`;
      const r = await renderKeyPages(origin, render);
      if (visibleWords(r) > visibleWords(pages)) { source = r.map((p) => ({ ...p, platform_hint: pages[0]?.platform_hint || "" })); rendered = true; }
    } catch (e) {
      logger.error(`[auto-setup] render failed for ${ctx.website.domain}: ${e?.message || e}`);
    }
  }
  const profile = await buildProfile(source, ai);
  const { client, website } = ctx;
  const p = profile.client;

  // --- client profile (fill empty only; the placeholder name = domain can be replaced)
  const clientPatch = {};
  for (const f of ["industry", "description", "primary_language", "country", "primary_location", "service_areas", "target_audience", "brand_voice", "services", "products", "primary_cta", "phone", "email"]) {
    if (!isEmpty(p[f]) && isEmpty(client[f])) clientPatch[f] = p[f];
  }
  if (p.business_name && (isEmpty(client.business_name) || looksLikeDomain(client.business_name))) clientPatch.business_name = p.business_name;
  if (Object.keys(clientPatch).length) await pb.collection("clients").update(client.id, clientPatch, { requestKey: null });

  // --- website (language decides the blog language)
  const websitePatch = {};
  if (isEmpty(website.primary_language)) websitePatch.primary_language = profile.language.language;
  if (isEmpty(website.country) && profile.country) websitePatch.country = profile.country;
  if (isEmpty(website.target_locations) && (p.service_areas || p.primary_location)) websitePatch.target_locations = String(p.service_areas || p.primary_location).slice(0, 500);
  if ((website.platform === "other" || isEmpty(website.platform)) && profile.platform) websitePatch.platform = profile.platform;
  if (p.business_name && looksLikeDomain(website.name)) websitePatch.name = p.business_name.slice(0, 200);
  if (Object.keys(websitePatch).length) await pb.collection("websites").update(website.id, websitePatch, { requestKey: null });

  // --- facts (skip duplicates, never touch existing ones)
  const existing = await pb.collection("business_facts").getFullList({ filter: `website = "${website.id}"`, requestKey: null });
  const seen = new Set(existing.map((f) => `${f.fact_type}:${normalizeText(String(f.value).replace(/<[^>]*>/g, ""))}`));
  let created = 0;
  let verified = 0;
  for (const f of profile.facts) {
    const key = `${f.fact_type}:${normalizeText(f.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const autoVerify = !NEVER_AUTO_VERIFY.has(f.fact_type);
    await pb.collection("business_facts").create({
      organization: ctx.org.id, client: client.id, website: website.id,
      fact_type: f.fact_type, label: f.label, value: f.value,
      source: `Website (auto-setup): "${String(f.quote).slice(0, 160)}"`,
      source_url: f.source_url,
      verified: autoVerify,
      verified_at: autoVerify ? now() : "",
      provenance: "website",
      verification_state: autoVerify ? "verified" : "unverified",
      created_at: now(), updated_at: now(),
    }, { requestKey: null });
    created++;
    if (autoVerify) verified++;
  }

  // --- queue topics (strategy) unless one is already queued/running
  let strategyJob = null;
  const active = await pb.collection("strategy_jobs").getList(1, 1, { filter: `website = "${website.id}" && (status = "queued" || status = "running")`, requestKey: null });
  if (!active.items.length && job.triggered_by) {
    strategyJob = await pb.collection("strategy_jobs").create({
      organization: ctx.org.id, client: client.id, website: website.id,
      status: "queued", step: "queued", progress: 0, triggered_by: job.triggered_by,
      configuration: { source: "auto_setup", crawl_job: job.id },
      created_at: now(), updated_at: now(),
    }, { requestKey: null });
  }

  const summary = {
    language: profile.language.language, language_source: profile.language.source,
    platform: profile.platform || website.platform, country: profile.country,
    client_fields: Object.keys(clientPatch), website_fields: Object.keys(websitePatch),
    facts_created: created, facts_verified: verified, facts_dropped_unquoted: profile.dropped,
    rendered, ai_used: profile.ai_used, ai_error: p._ai_error || null, usage: profile.usage,
    strategy_job: strategyJob?.id || null,
  };
  logger.log(`[auto-setup] ${website.domain}: lang=${summary.language}(${summary.language_source}) facts=${created} (verified ${verified}, dropped ${profile.dropped}) ai=${summary.ai_used} rendered=${rendered}${summary.ai_error ? ` err=${summary.ai_error}` : ""}`);
  return summary;
}
