import "server-only";
import { revalidatePath, revalidateTag } from "next/cache";
import { bunkerConfig, bunkerSecrets, contentTag } from "./config";
import { localNonceStore, localUnpublish, localUpsert } from "./local-store";
import { HEADERS, memoryNonceStore, rateLimited, verifySignature } from "./signing";
import type { PublicArticle } from "./types";

const MAX_BODY = 2_500_000;
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

async function authenticate(req: Request, nonces: Parameters<typeof verifySignature>[3]) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (rateLimited(ip)) return { error: json(429, { ok: false, code: "RATE_LIMITED" }) };
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_BODY) return { error: json(413, { ok: false, code: "PAYLOAD_TOO_LARGE" }) };
  const raw = await req.text();
  if (raw.length > MAX_BODY) return { error: json(413, { ok: false, code: "PAYLOAD_TOO_LARGE" }) };
  const cfg = bunkerConfig();
  // The request must be addressed to THIS website; the signature binds it.
  if (req.headers.get(HEADERS.website) !== cfg.websiteId) return { error: json(403, { ok: false, code: "WRONG_WEBSITE" }) };
  const v = await verifySignature(req.headers, raw, bunkerSecrets(), nonces);
  if (!v.ok) return { error: json(v.code === "NOT_CONFIGURED" ? 503 : 401, { ok: false, code: v.code }) };
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return { error: json(400, { ok: false, code: "INVALID_JSON" }) }; }
  if (body.website_id !== cfg.websiteId) return { error: json(403, { ok: false, code: "WRONG_WEBSITE" }) };
  return { body, cfg };
}

function revalidateArticle(slug?: string) {
  const cfg = bunkerConfig();
  revalidateTag(contentTag(cfg.websiteId), { expire: 0 });
  revalidatePath(cfg.blogPath);
  if (slug) revalidatePath(`${cfg.blogPath}/${slug}`);
  revalidatePath("/sitemap.xml");
}

/** POST /api/bunker-content/revalidate — signed, idempotent, no content writes. */
export async function handleRevalidate(req: Request) {
  const a = await authenticate(req, memoryNonceStore);
  if ("error" in a) return a.error;
  const paths = Array.isArray(a.body.paths) ? a.body.paths.filter((p): p is string => typeof p === "string" && /^\/[a-z0-9\-_/.]*$/i.test(p)).slice(0, 20) : [];
  if (a.body.dry_run === true) return json(200, { ok: true, dry_run: true });
  revalidateTag(contentTag(a.cfg.websiteId), { expire: 0 });
  for (const p of paths) revalidatePath(p);
  return json(200, { ok: true, revalidated: paths.length });
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validArticle(x: unknown): x is PublicArticle {
  if (!x || typeof x !== "object") return false;
  const a = x as Record<string, unknown>;
  return typeof a.title === "string" && a.title.trim().length > 0 && a.title.length <= 300
    && typeof a.slug === "string" && SLUG_RE.test(a.slug) && a.slug.length <= 200
    && typeof a.content === "string" && a.content.trim().length > 0 && a.content.length <= 2_000_000
    && typeof a.revision === "string" && /^[a-f0-9]{16}$/.test(a.revision);
}

/**
 * POST /api/bunker-content/publish — Next.js API publisher mode (local copy).
 * Operations: ping | publish | update | unpublish. Returns remote_id + public_url.
 */
export async function handlePublish(req: Request) {
  const a = await authenticate(req, localNonceStore);
  if ("error" in a) return a.error;
  const { body, cfg } = a;
  const op = String(body.operation || "");
  if (op === "ping") return json(200, { ok: true, website_id: cfg.websiteId, mode: cfg.source });
  if (cfg.source !== "local") return json(409, { ok: false, code: "LOCAL_STORE_DISABLED" });
  const key = String(body.idempotency_key || "");
  if (!key || key.length > 200) return json(400, { ok: false, code: "IDEMPOTENCY_KEY_REQUIRED" });
  if (op === "publish" || op === "update" || op === "republish" || op === "rollback") {
    const article = body.article as Record<string, unknown> | undefined;
    if (!validArticle(article)) return json(400, { ok: false, code: "INVALID_PAYLOAD" });
    const articleId = String((body.article as Record<string, unknown>).article_id || "");
    if (!/^[a-z0-9]{15}$/.test(articleId)) return json(400, { ok: false, code: "INVALID_PAYLOAD" });
    const r = await localUpsert(articleId, typeof body.remote_id === "string" ? body.remote_id : undefined, article, key);
    if ("conflict" in r) return json(409, { ok: false, code: "SLUG_CONFLICT" });
    revalidateArticle(article.slug);
    return json(200, { ok: true, remote_id: r.remote_id, public_url: `${cfg.siteUrl}${cfg.blogPath}/${article.slug}`, replay: r.replay });
  }
  if (op === "unpublish") {
    const ok = await localUnpublish(String(body.article_id || ""), String(body.remote_id || ""));
    if (!ok) return json(404, { ok: false, code: "NOT_FOUND" });
    revalidateArticle(typeof body.slug === "string" && SLUG_RE.test(body.slug) ? body.slug : undefined);
    return json(200, { ok: true });
  }
  return json(400, { ok: false, code: "UNKNOWN_OPERATION" });
}
