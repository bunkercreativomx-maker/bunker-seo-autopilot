// Featured image for each Autopilot post (FAL). Optional: without FAL_KEY, or
// when the FAL account is out of balance, posts simply have no image. Images
// are generic photos (no text, no logos) so they cannot invent business facts.
const MODEL = "fal-ai/flux/dev";

export function imagePrompt(article, { hint = "", business = "" } = {}) {
  const clean = (v, n) => String(v || "").replace(/["<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
  const topic = clean(article.title || article.primary_keyword, 160);
  const extra = clean(hint, 240);
  return [
    `Realistic editorial photograph for a blog article about: ${topic}.`,
    business ? `Context: a local service business (${clean(business, 80)}).` : "",
    extra ? `Scene: ${extra}.` : "Show the real subject of the topic (equipment, a professional at work, or the place where it is used).",
    "Documentary style, natural light, real everyday setting, professional composition, sharp focus, high detail.",
    "No text, no letters, no words, no numbers, no signs, no logos, no watermarks, no brand names.",
  ].filter(Boolean).join(" ");
}

export function falFromEnv(env = process.env, { fetchImpl = globalThis.fetch, logger = console } = {}) {
  const key = String(env.FAL_KEY || "").trim();
  if (!key) return null;
  return async function generate(article, opts = {}) {
    try {
      const res = await fetchImpl(`https://fal.run/${MODEL}`, {
        method: "POST",
        headers: { authorization: `Key ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt: imagePrompt(article, opts), image_size: "landscape_16_9", num_images: 1, num_inference_steps: 28, enable_safety_checker: true }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) {
        logger.error(`[autopilot] image HTTP ${res.status}`);
        return { ok: false, code: res.status === 403 ? "FAL_ACCOUNT_LOCKED" : `HTTP_${res.status}` };
      }
      const j = await res.json();
      const url = j?.images?.[0]?.url;
      if (!/^https:\/\//.test(String(url || ""))) return { ok: false, code: "NO_IMAGE" };
      return { ok: true, url };
    } catch (e) {
      logger.error(`[autopilot] image error ${String(e?.name || "")}`);
      return { ok: false, code: "IMAGE_ERROR" };
    }
  };
}
