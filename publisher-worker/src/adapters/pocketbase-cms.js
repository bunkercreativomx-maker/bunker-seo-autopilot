// PocketBase CMS mode: the website reads published_content directly from
// PocketBase (public, published-only rule). Content never goes through Git.
import { PublisherAdapter, PublishError } from "./base.js";
import { publicPayload } from "../content.js";
import { revalidate } from "../revalidate.js";

const esc = (v) => String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export class PocketBaseCMSPublisher extends PublisherAdapter {
  get name() { return "pocketbase_cms"; }
  get pb() { return this.deps.pb; }
  async existingRow(ctx) {
    if (!ctx.publication?.id) return null;
    try { return await this.pb.collection("published_content").getFirstListItem(`publication = "${esc(ctx.publication.id)}"`); } catch (e) { if (e?.status === 404) return null; throw e; }
  }
  async testConnection(ctx) {
    // Reachability of the public read API for this website + the public site.
    const api = await this.publicApi(ctx, "__connection_test__");
    if (api.status !== 200) throw new PublishError("INVALID_RESPONSE", `Public content API returned ${api.status}`);
    const res = await this.http(String(ctx.website.base_url).replace(/\/+$/, "") + (ctx.website.blog_path || ""), { method: "GET" }, ctx);
    if (res.status !== 200) throw new PublishError(res.status === 401 || res.status === 403 ? "UNAUTHORIZED" : "INVALID_RESPONSE", `Blog index returned ${res.status}`);
    const cfg = ctx.website.publishing_configuration || {};
    if (cfg.revalidate_url) await revalidate(this, ctx, { paths: [ctx.website.blog_path || "/blog"], dryRun: true });
    return { ok: true, detail: { blog_status: res.status } };
  }
  async upsert(snapshot, ctx, hash) {
    const url = this.getPublicUrl(snapshot.slug, ctx);
    const ts = new Date().toISOString();
    const clash = await this.pb.collection("published_content").getList(1, 1, { filter: `website = "${esc(ctx.website.id)}" && slug = "${esc(snapshot.slug)}" && publication != "${esc(ctx.publication.id)}"` });
    if (clash.totalItems) throw new PublishError("SLUG_CONFLICT", "Another publication already uses this slug on the website");
    const existing = await this.existingRow(ctx);
    const data = {
      ...publicPayload(snapshot, ctx.website, { url, publishedAt: existing?.published_at || ts, updatedAt: ts, hash }),
      organization: ctx.website.organization, client: ctx.website.client, website: ctx.website.id,
      publication: ctx.publication.id, article: ctx.job.article, article_version: snapshot.version, status: "published",
    };
    const row = existing ? await this.pb.collection("published_content").update(existing.id, data) : await this.pb.collection("published_content").create(data);
    await revalidate(this, ctx, { paths: [ctx.website.blog_path || "/blog", `${ctx.website.blog_path || ""}/${snapshot.slug}`, "/sitemap.xml"] });
    return { remoteId: row.id, publicUrl: url, response: { stored: true } };
  }
  publish(snapshot, ctx, hash) { return this.upsert(snapshot, ctx, hash); }
  update(snapshot, ctx, hash) { return this.upsert(snapshot, ctx, hash); }
  async unpublish(ctx) {
    const row = await this.existingRow(ctx);
    // Never hard-delete: flip visibility; the public rule only exposes "published".
    if (row) await this.pb.collection("published_content").update(row.id, { status: "unpublished" });
    await revalidate(this, ctx, { paths: [ctx.website.blog_path || "/blog", `${ctx.website.blog_path || ""}/${ctx.publication.slug}`, "/sitemap.xml"] });
    return { response: { hidden: Boolean(row) } };
  }
  /** Anonymous read exactly as a public visitor would (no auth header). */
  async publicApi(ctx, slug) {
    const base = String(this.deps.publicPbUrl || this.env.PB_PUBLIC_READ_URL || this.env.PB_URL).replace(/\/+$/, "");
    const qs = new URLSearchParams({ website: ctx.website.id, filter: `slug = "${esc(slug)}"`, perPage: "1" });
    const res = await fetch(`${base}/api/collections/published_content/records?${qs}`, { headers: { accept: "application/json" } });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  }
  async verify(ctx, { expect, hash, url, slug, title }) {
    const checks = [];
    const api = await this.publicApi(ctx, slug);
    const item = api.json?.items?.[0];
    checks.push({ public_api: api.status, found: Boolean(item) });
    if (expect === "live") {
      if (!item) return { ok: false, checks, reason: "Published content is not visible through the public API" };
      if (item.revision !== String(hash).slice(0, 16)) return { ok: false, checks, reason: "Public API serves a different version" };
      for (const k of ["organization", "client", "article", "publication", "article_version"]) if (k in item) return { ok: false, checks, reason: `Public API leaks internal field ${k}` };
    } else if (item) return { ok: false, checks, reason: "Content is still visible through the public API" };
    const cfg = ctx.website.publishing_configuration || {};
    if (cfg.verify_page !== false) {
      const page = await this.verifyPage(ctx, { url, expect, hash, title, marker: cfg.verify_marker !== false });
      checks.push(page.check);
      if (!page.ok) return { ok: false, checks, reason: page.reason };
      const sm = await this.verifySitemap(ctx, { url, expect });
      checks.push(sm.check);
      if (!sm.ok) return { ok: false, checks, reason: sm.reason };
    }
    return { ok: true, checks };
  }
}
