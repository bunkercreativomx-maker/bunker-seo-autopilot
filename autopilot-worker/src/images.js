// Featured image for each post.
// Pipeline: (1) "art director" (gpt-5-mini) reads the post + the client profile and
// writes a concrete scene that matches what the post is about and who it is for;
// (2) GPT Image 2 (FAL, quality medium) renders it; (3) a vision check (gpt-5-mini)
// rejects off-topic images or garbled text and retries once with the reason.
// Without OPENAI_API_KEY it falls back to a context prompt with no QA; without
// FAL_KEY images are off. Photos carry no text/logos so they cannot invent facts.
const MODEL = "openai/gpt-image-2";
const AI_MODEL = "gpt-5-mini";
const MAX_ATTEMPTS = 2;

const clean = (v, n) => String(v ?? "").replace(/["<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
const plain = (html, n) => clean(String(html || "").replace(/<[^>]+>/g, " ").replace(/[#*_`|]+/g, " "), n);
const list = (v, n) => clean(Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : x?.name || x?.title || "")).join(", ") : v, n);

export function headings(content, max = 8) {
  const s = String(content || "");
  const out = [];
  for (const m of s.matchAll(/<h[23][^>]*>(.*?)<\/h[23]>/gis)) out.push(plain(m[1], 120));
  for (const m of s.matchAll(/^#{2,3}\s+(.+)$/gm)) out.push(plain(m[1], 120));
  return out.filter(Boolean).slice(0, max);
}

export function postContext(article, { client = null, website = null, hint = "" } = {}) {
  const c = client || {};
  const loc = [c.primary_location, list(c.service_areas, 120), list(website?.target_locations, 120), article.target_location, c.country || website?.country]
    .map((x) => clean(x, 120)).filter(Boolean);
  return {
    post_title: clean(article.title || article.primary_keyword, 200),
    primary_keyword: clean(article.primary_keyword, 120),
    language: clean(article.language, 10),
    excerpt: plain(article.excerpt || article.meta_description, 400),
    sections: headings(article.content),
    opening: plain(article.content, 900),
    business_name: clean(c.business_name || website?.name, 80),
    business_does: clean(c.description || c.industry, 300),
    services: list(c.services, 300),
    audience: clean(c.target_audience, 240),
    location: [...new Set(loc)].join(" · ").slice(0, 240),
    human_request: clean(hint, 300),
  };
}

const DIRECTOR = `You are the photo editor of a local-business blog. Pick ONE featured photograph for the post.
Rules:
- The photo must show what THIS post is about from the reader's point of view, not the business in general. Read the title, sections and opening.
- Show the people the post is written for (the audience) in their real situation: right age, right country/city look (Ciudad Juárez/Mexico = Mexican people, Mexican homes/streets/businesses; El Paso = US Southwest border city, often Hispanic families), everyday clothes, real homes/offices/shops/streets.
- Pick a concrete moment with an action (e.g. "a retired couple at their kitchen table talking with a friendly advisor", "a waiter taking an order on a tablet at a busy taquería", "a technician checking a rooftop AC unit under a clear desert sky").
- Never default to "a technician with a machine" unless the post is about repairing/installing equipment.
- Money/credit/legal topics: show people and a warm conversation or the life goal the money enables, never piles of cash, bank logos or contracts with readable text.
- Software/business topics: show the business moment the software helps with (customers, staff, counter, owner); screens only seen from the side or blurred.
- Product posts (printing, signage, apparel, cards, stickers, banners, merchandise): the finished product must be the hero and instantly recognizable for what it is — e.g. a fanned stack of printed business cards with a colorful design, a large vinyl banner being hung on a storefront, DTF-printed t-shirts on a rack. Blank white cards or plain paper read as "nothing"; printed items should carry colors, shapes, logo-like marks or out-of-focus print, never legible words.
- Avoid anything that needs readable text: no signs, labels, screens facing camera, or documents with visible writing. Out-of-focus or abstract print is fine.
- If human_request is present, follow it.
Answer in English.`;

const DIRECTOR_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["scene", "hero_object", "people", "setting", "light_mood", "framing"],
  properties: {
    scene: { type: "string", description: "One sentence: who is doing what, tied to the post topic." },
    hero_object: { type: "string", description: "The ONE thing the viewer must recognize at first glance, described concretely (e.g. 'a fanned stack of thick business cards printed with a bold two-color design'), or 'none'." },
    people: { type: "string", description: "Age, look, clothing; or 'none'." },
    setting: { type: "string", description: "Concrete place, local to the business city/country." },
    light_mood: { type: "string" },
    framing: { type: "string", description: "Camera framing, e.g. medium shot at eye level." },
  },
};

const QA = `You check a blog featured photo before it goes live. Be strict.
fits=false if the photo does not clearly relate to the post topic and audience (wrong subject, wrong kind of people, wrong country look).
garbled_text=true if readable or pseudo-readable letters, words, fake text, labels, signs, logos or numbers are visible. Out-of-focus, abstract or indistinct print on products is fine.
fits=false also when the post is about a product (cards, banners, shirts, stickers, signs) and that product is not clearly recognizable in the photo (blank paper or generic samples do not count).
artifacts=true for deformed hands/faces, melted objects, impossible machines, or an obviously fake CGI look.
reason: one short sentence on what to fix.`;

const QA_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["fits", "garbled_text", "artifacts", "reason"],
  properties: { fits: { type: "boolean" }, garbled_text: { type: "boolean" }, artifacts: { type: "boolean" }, reason: { type: "string" } },
};

export function photoPrompt(brief, ctx) {
  if (!brief) {
    return [
      `Realistic editorial photograph for a blog post titled "${ctx.post_title}"${ctx.audience ? `, written for ${ctx.audience}` : ""}${ctx.location ? `, in ${ctx.location}` : ""}.`,
      ctx.human_request ? `Scene: ${ctx.human_request}.` : "Show the people and the real situation the post talks about.",
      "Documentary style, natural light, authentic everyday setting, candid, sharp focus.",
      "Absolutely no text, letters, numbers, signs, labels, logos or watermarks anywhere in the image.",
    ].join(" ");
  }
  return [
    `Candid documentary photograph, full-frame camera, 35mm lens. ${clean(brief.scene, 400)}`,
    brief.hero_object && !/^none\.?$/i.test(brief.hero_object.trim()) ? `Main subject, large in frame and instantly recognizable: ${clean(brief.hero_object, 240)}.` : "",
    brief.people && !/^none\.?$/i.test(brief.people.trim()) ? `People: ${clean(brief.people, 240)}.` : "",
    `Setting: ${clean(brief.setting, 240)}.`,
    `Light and mood: ${clean(brief.light_mood, 160)}. Framing: ${clean(brief.framing, 160)}.`,
    "Natural skin texture, real-world imperfections, believable everyday details, not staged stock, not CGI.",
    "No legible text, letters, numbers, signs, labels, logos, brand names or watermarks anywhere; printed items may show colors, abstract graphics or out-of-focus print, never readable words; screens are blank or out of focus.",
  ].filter(Boolean).join(" ");
}

function outputText(j) {
  if (typeof j?.output_text === "string") return j.output_text;
  for (const o of j?.output || []) for (const c of o?.content || []) if (c?.type === "output_text" && c.text) return c.text;
  return "";
}

async function openaiJson(fetchImpl, key, { instructions, input, schema, name }) {
  const res = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: AI_MODEL, instructions, input, reasoning: { effort: "low" }, text: { format: { type: "json_schema", name, strict: true, schema } } }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  return JSON.parse(outputText(await res.json()));
}

async function falImage(fetchImpl, key, prompt) {
  const h = { authorization: `Key ${key}`, "content-type": "application/json" };
  const q = await fetchImpl(`https://queue.fal.run/${MODEL}`, {
    method: "POST", headers: h,
    body: JSON.stringify({ prompt, image_size: "landscape_16_9", quality: "medium", num_images: 1, output_format: "jpeg" }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!q.ok) return { ok: false, code: q.status === 403 ? "FAL_ACCOUNT_LOCKED" : `HTTP_${q.status}` };
  const { status_url, response_url } = await q.json();
  if (!status_url || !response_url) return { ok: false, code: "FAL_QUEUE" };
  let done = false;
  for (let i = 0; i < 60 && !done; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const s = await fetchImpl(status_url, { headers: h, signal: AbortSignal.timeout(30_000) }).then((r) => r.json()).catch(() => ({}));
    if (s.status === "COMPLETED") done = true;
    else if (s.status === "FAILED" || s.status === "ERROR") return { ok: false, code: "FAL_FAILED" };
  }
  if (!done) return { ok: false, code: "FAL_TIMEOUT" };
  const j = await fetchImpl(response_url, { headers: h, signal: AbortSignal.timeout(30_000) }).then((r) => r.json()).catch(() => ({}));
  const url = j?.images?.[0]?.url;
  return /^https:\/\//.test(String(url || "")) ? { ok: true, url } : { ok: false, code: "NO_IMAGE" };
}

export function imageGenerator({ falKey, openaiKey, fetchImpl = globalThis.fetch, logger = console } = {}) {
  if (!falKey) return null;
  return async function generate(article, opts = {}) {
    const ctx = postContext(article, opts);
    let feedback = "";
    let last = { ok: false, code: "IMAGE_ERROR" };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        let brief = null;
        if (openaiKey) {
          try {
            brief = await openaiJson(fetchImpl, openaiKey, {
              instructions: DIRECTOR, name: "photo_brief", schema: DIRECTOR_SCHEMA,
              input: JSON.stringify(feedback ? { ...ctx, previous_photo_rejected_because: feedback } : ctx),
            });
          } catch (e) { logger.error(`[autopilot] image brief failed ${String(e?.message || e).slice(0, 80)}`); }
        }
        const prompt = photoPrompt(brief, ctx);
        const r = await falImage(fetchImpl, falKey, prompt);
        if (!r.ok) return r; // provider/billing problem: retrying won't help
        last = { ...r, prompt, brief };
        if (!openaiKey) return last;
        let qa;
        try {
          qa = await openaiJson(fetchImpl, openaiKey, {
            instructions: QA, name: "photo_qa", schema: QA_SCHEMA,
            input: [{ role: "user", content: [
              { type: "input_text", text: JSON.stringify({ post_title: ctx.post_title, audience: ctx.audience, location: ctx.location, intended_scene: brief?.scene || "" }) },
              { type: "input_image", image_url: r.url },
            ] }],
          });
        } catch (e) { logger.error(`[autopilot] image qa failed ${String(e?.message || e).slice(0, 80)}`); return last; }
        last.qa = qa;
        if (qa.fits && !qa.garbled_text && !qa.artifacts) return last;
        feedback = clean(qa.reason, 300);
        logger.log(`[autopilot] image rejected (attempt ${attempt}): ${feedback}`);
      } catch (e) {
        logger.error(`[autopilot] image error ${String(e?.name || e?.message || "")}`.slice(0, 120));
        return { ok: false, code: "IMAGE_ERROR" };
      }
    }
    return last; // best effort: keep the last image rather than none
  };
}

export function falFromEnv(env = process.env, { fetchImpl = globalThis.fetch, logger = console } = {}) {
  const falKey = String(env.FAL_KEY || "").trim();
  const openaiKey = String(env.OPENAI_API_KEY || "").trim();
  return imageGenerator({ falKey, openaiKey, fetchImpl, logger });
}

// Kept for older callers.
export function imagePrompt(article, { hint = "", business = "" } = {}) {
  return photoPrompt(null, postContext(article, { hint, website: { name: business } }));
}
