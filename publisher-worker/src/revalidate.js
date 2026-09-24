// Signed on-demand revalidation (Next.js revalidatePath/revalidateTag) — no redeploy.
import { sign, HEADERS } from "./signing.js";
import { httpError, PublishError } from "./net.js";

export async function revalidate(adapter, ctx, { paths = [], dryRun = false } = {}) {
  const cfg = ctx.website.publishing_configuration || {};
  if (!cfg.revalidate_url) return { skipped: true };
  if (!ctx.secrets?.length) throw new PublishError("NOT_CONFIGURED", "Revalidation requires a configured secret");
  const body = JSON.stringify({ website_id: ctx.website.id, paths: [...new Set(paths)], tags: [`bunker-content:${ctx.website.id}`], dry_run: dryRun });
  const res = await adapter.http(cfg.revalidate_url, { method: "POST", headers: { "content-type": "application/json", [HEADERS.website]: ctx.website.id, ...sign(ctx.secrets[0], body) }, body }, ctx);
  if (res.status < 200 || res.status > 299) throw httpError(res.status, "Revalidation endpoint");
  return { ok: true };
}
