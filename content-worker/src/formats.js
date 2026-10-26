// Post formats: proven persuasion structures (AIDA, PAS, StoryBrand…) picked
// by CODE from the topic, so every post has a sales structure without the
// model improvising one. Formats shape ORDER and FRAMING only — they never
// authorize a fact. Every format obeys the evidence rules of the writer.
import { normalizeForMatch } from "./text.js";

export const POST_FORMATS = {
  problem_solution: {
    label: "Problem → Solution (PAS)",
    match: /\b(por que|porque no|no (enfria|prende|funciona|carga|calienta|sirve|jala)|gotea|falla\w*|problema\w*|error\w*|se (apaga|calienta|congela|rompe)|why|not working|doesn t|won t|leak\w*|problem\w*|issue\w*|fix\w*|broken)\b/,
    guide: `FORMAT = PROBLEM → AGITATE → SOLVE (PAS).
1. Open with the reader's problem in their own words (what they see, hear, pay or worry about) — 2–3 sentences, no fluff.
2. Agitate honestly: what usually happens if it is ignored (general, stable knowledge; no invented numbers or scare tactics).
3. Solve: the common causes and what the reader can safely check themselves (general advice), then when it is time to call a professional.
4. Short CTA after the causes section and a closing CTA: the business can review the reader's specific case (verified contacts only).`,
  },
  signs_list: {
    label: "Warning signs checklist",
    match: /\b(senales|sintomas|cuando (cambiar|reemplazar|llamar|es momento)|signs?|symptoms?|when to (replace|call|change)|time to)\b/,
    guide: `FORMAT = WARNING-SIGNS CHECKLIST.
1. Hook: one sentence the reader recognizes ("if you noticed X…").
2. A numbered list of signs (H2 per sign or a clear list), each: what it looks like + why it matters (general knowledge).
3. "What to do next": what the reader can check alone vs. what needs a professional.
4. CTA after the list: they can describe their signs to the business (verified contacts only).`,
  },
  cost_guide: {
    label: "What it costs (honest cost guide)",
    match: /\b(cuanto (cuesta|cobra\w*|sale|vale)|precio\w*|costo\w*|tarifa\w*|presupuesto|cost\w*|price\w*|how much|pricing|budget)\b/,
    guide: `FORMAT = HONEST COST GUIDE.
1. Answer up front: the price depends on specific factors — say it plainly instead of dodging.
2. H2 per cost factor (size, materials, condition, access, extras…) explained as general knowledge.
3. Ways the reader can avoid paying more than needed (general advice).
4. ONLY if a VERIFIED price/promotion fact (F*) exists, state it verbatim; otherwise NO amounts, ranges, percentages or "free" anything.
5. CTA: the exact number depends on their case — contact the business to know theirs (verified contacts only).`,
  },
  comparison: {
    label: "Comparison (A vs B)",
    match: /\b(vs|versus|diferencia\w*|comparativ\w*|compara\w*|cual es mejor|que conviene|difference\w*|compare\w*|comparison|which is better)\b|\b(\w+) o (\w+) (cual|que) /,
    guide: `FORMAT = FAIR COMPARISON.
1. Who this comparison is for and the decision they face.
2. Each option explained fairly (how it works, pros, cons) — no invented specs, prices or performance numbers.
3. A side-by-side summary (markdown table allowed) using only qualitative, sourced or general points.
4. "Which one fits you" by situation, then CTA: the business can help them decide for their case (verified contacts only).`,
  },
  faq: {
    label: "Real questions answered (FAQ)",
    match: /\b(preguntas|dudas|que es|que significa|sirve|faq|questions|what is|what does|does it|is it|can i)\b/,
    guide: `FORMAT = REAL QUESTIONS ANSWERED.
1. One-paragraph direct answer to the main question first (featured-snippet style).
2. H2 per related question searchers ask, each answered in 2–4 direct sentences.
3. No question whose answer needs unverified business facts.
4. CTA at the end: other questions about their case → contact the business (verified contacts only).`,
  },
  how_to: {
    label: "Step-by-step guide (StoryBrand)",
    match: /\b(como|pasos|guia|tips|consejos|ideas|how to|how do|steps?|guide|tips|checklist|ways to)\b/,
    guide: `FORMAT = STORYBRAND GUIDE. The reader is the hero; the business is the guide.
1. The reader's goal and what stands in the way (1 short paragraph).
2. Empathy + authority WITHOUT invented credentials: show you understand the problem by explaining it clearly.
3. The plan: numbered steps (H2/H3) the reader can follow, general and practical.
4. Success vs. failure: what life looks like when it is done right (framing only, no promised outcomes or numbers).
5. CTA: if they prefer not to do it alone, the business can help (verified contacts only).`,
  },
  aida: {
    label: "Attention → Interest → Desire → Action (AIDA)",
    match: null,
    guide: `FORMAT = AIDA.
1. ATTENTION: open with the reader's situation or a striking, TRUE general fact (sourced or common knowledge) — no clickbait.
2. INTEREST: explain the topic clearly and usefully (the bulk of the post; H2 sections).
3. DESIRE: describe the result the reader wants using the AUDIENCE ANGLE (how it feels / how it looks / time saved) — framing only, never a promise or a number that is not an F* fact.
4. ACTION: one clear next step with verified contacts only; a short CTA after the first main section and a closing CTA.`,
  },
  aida_service: {
    label: "Service page (AIDA)",
    match: null,
    guide: `FORMAT = SERVICE PAGE WITH AIDA.
1. ATTENTION: the reader's need in one line + what the service is.
2. INTEREST: who it is for, what is included — ONLY as stated by F* facts or the client's own site (C*).
3. DESIRE: the outcome for this reader (AUDIENCE ANGLE framing), plus trust signals ONLY if they are F* facts (real reviews quoted verbatim, verified years, licenses).
4. ACTION: how to start (verified contacts only), repeated at the end.`,
  },
};

const ORDER = ["comparison", "cost_guide", "problem_solution", "signs_list", "faq", "how_to"];

/** Deterministic: the same topic always gets the same format. */
export function pickFormat(meta = {}) {
  const type = meta.content_type || "blog_article";
  if (["service_page", "location_page", "existing_page_optimization"].includes(type)) return "aida_service";
  if (type === "comparison") return "comparison";
  if (type === "faq_page") return "faq";
  const text = ` ${normalizeForMatch(`${meta.primary_keyword || ""} ${meta.title || ""}`)} `;
  for (const key of ORDER) if (POST_FORMATS[key].match.test(text)) return key;
  return type === "guide" ? "how_to" : "aida";
}

export function formatGuide(meta = {}) {
  const key = meta.post_format && POST_FORMATS[meta.post_format] ? meta.post_format : pickFormat(meta);
  return `POST STRUCTURE (${POST_FORMATS[key].label}) — follow this order. It shapes structure and framing only; it never allows a business fact, number, price, promise, review or credential that is not an F* fact.\n${POST_FORMATS[key].guide}`;
}

// ---------------------------------------------------------------- hype filter
// Superlatives and absolute promises in the business's own voice ("somos los
// mejores", "100% garantizado", "the #1 company") are removed by code unless a
// verified fact says the same words. General advice ("la mejor forma de…") stays.
const HYPE = /\b(el mejor|la mejor|los mejores|las mejores|mejor(es)? (servicio|precio|calidad|empresa|opcion de la ciudad|de (la ciudad|juarez|el paso|mexico|la region|texas))|numero uno|no\. ?1|lider(es)?( en)?|insuperable\w*|inigualable\w*|sin competencia|100 ?%(?= )|100 por ciento|garantizad\w*|garantia total|siempre (cumplimos|llegamos|a tiempo)|nunca (fallamos|falla)|the best|best (service|price|quality|company|in town|in (el paso|texas|the city|the area))|number one|#1|industry leading|leading|unbeatable|unmatched|guaranteed|always on time|never fail\w*)\b/;
const BUSINESS_VOICE = /\b(somos|ofrecemos|nuestr[oa]s?|contamos|trabajamos|brindamos|te (ofrecemos|damos|garantizamos)|nosotros|en \w+ (somos|ofrecemos)|we|our|us|we re|we are)\b/;

export function hypeSentences(markdown, { verifiedFacts = [], brandTerms = [] } = {}) {
  const factText = normalizeForMatch(verifiedFacts.filter((f) => !String(f.value || "").startsWith("NOT OFFERED")).map((f) => `${f.label || ""} ${f.value || ""}`).join(" "));
  const brands = brandTerms.map((b) => normalizeForMatch(b)).filter((b) => b.length >= 3);
  const out = [];
  for (const line of String(markdown || "").split("\n")) {
    if (/^\s*#\s/.test(line)) continue; // never touch the H1
    for (const sentence of line.replace(/^\s*(#{2,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "").split(/(?<=[.!?])\s+/)) {
      const n = ` ${normalizeForMatch(sentence)} `;
      const m = n.match(HYPE) || (/#\s?1\b/.test(sentence) ? ["#1"] : null);
      if (!m) continue;
      const voice = BUSINESS_VOICE.test(n) || brands.some((b) => n.includes(` ${b} `) || n.includes(b));
      if (!voice) continue;
      if (factText.includes(normalizeForMatch(m[0]))) continue;
      out.push(sentence.trim());
    }
  }
  return out;
}
