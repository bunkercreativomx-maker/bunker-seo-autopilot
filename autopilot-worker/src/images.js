// Featured image for each Autopilot post (FAL). Optional: without FAL_KEY, or
// when the FAL account is out of balance, posts simply have no image. Images
// are generic photos (no text, no logos) so they cannot invent business facts.
const MODEL = "fal-ai/flux/schnell";

export function imagePrompt(article) {
  const topic = String(article.title || article.primary_keyword || "").replace(/["<>]/g, "").slice(0, 160);
  return `Realistic editorial photograph illustrating: ${topic}. Natural light, professional, high detail. No text, no letters, no words, no logos, no watermarks, no brand names.`;
}

export function falFromEnv(env = process.env, { fetchImpl = globalThis.fetch, logger = console } = {}) {
  const key = String(env.FAL_KEY || "").trim();
  if (!key) return null;
  return async function generate(article) {
    try {
      const res = await fetchImpl(`https://fal.run/${MODEL}`, {
        method: "POST",
        headers: { authorization: `Key ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt: imagePrompt(article), image_size: "landscape_16_9", num_images: 1, enable_safety_checker: true }),
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
