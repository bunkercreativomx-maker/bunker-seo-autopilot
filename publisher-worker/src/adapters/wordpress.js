// WordPress REST API adapter (secondary). Auth: Application Passwords
// (username + app password via Basic auth). SEO-plugin metadata is opt-in per
// integration config because plugins expose different (or no) REST fields.
import { PublisherAdapter, requireSecret, httpError, PublishError } from "./base.js";
import { markdownToSafeHtml, canonicalFor } from "../content.js";

export class WordPressPublisher extends PublisherAdapter {
  get name() { return "wordpress"; }
  api(ctx, path) { return String(ctx.website.api_endpoint).replace(/\/+$/, "") + path; }
  auth(ctx) {
    const user = ctx.integration.username;
    if (!user) throw new PublishError("NOT_CONFIGURED", "WordPress username is not configured");
    return { authorization: "Basic " + Buffer.from(`${user}:${requireSecret(ctx)}`).toString("base64") };
  }
  async call(ctx, method, path, body) {
    const res = await this.http(this.api(ctx, path), { method, headers: { ...this.auth(ctx), accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }, ctx);
    if (res.status < 200 || res.status > 299) throw httpError(res.status, "WordPress");
    const json = res.json();
    if (json === null) throw new PublishError("INVALID_RESPONSE", "WordPress did not return JSON");
    return json;
  }
  async testConnection(ctx) {
    const me = await this.call(ctx, "GET", "/wp/v2/users/me?context=edit");
    if (!me?.id) throw new PublishError("INVALID_RESPONSE", "Unexpected WordPress user response");
    return { ok: true, detail: { user_id: me.id } };
  }
  body(snapshot, ctx) {
    const cfg = ctx.integration.config || ctx.website.publishing_configuration || {};
    const out = { title: snapshot.title, slug: snapshot.slug, excerpt: snapshot.excerpt, content: markdownToSafeHtml(snapshot.content), status: cfg.wordpress_status === "draft" ? "draft" : "publish" };
    if (Number(cfg.featured_media_id) > 0) out.featured_media = Number(cfg.featured_media_id);
    const canonical = canonicalFor(snapshot, ctx.website, this.getPublicUrl(snapshot.slug, ctx));
    if (cfg.wordpress_seo_plugin === "yoast") out.meta = { _yoast_wpseo_title: snapshot.seo_title, _yoast_wpseo_metadesc: snapshot.meta_description, _yoast_wpseo_canonical: canonical };
    if (cfg.wordpress_seo_plugin === "rankmath") out.meta = { rank_math_title: snapshot.seo_title, rank_math_description: snapshot.meta_description, rank_math_canonical_url: canonical };
    return out;
  }
  async publish(snapshot, ctx) {
    if (ctx.publication?.remote_id) return this.update(snapshot, ctx);
    const existing = await this.call(ctx, "GET", `/wp/v2/posts?slug=${encodeURIComponent(snapshot.slug)}&status=publish,draft,pending,private,future&context=edit`);
    if (Array.isArray(existing) && existing.length) throw new PublishError("SLUG_CONFLICT", "A WordPress post already uses this slug; it will not be overwritten");
    const post = await this.call(ctx, "POST", "/wp/v2/posts", this.body(snapshot, ctx));
    return { remoteId: String(post.id), publicUrl: String(post.link || this.getPublicUrl(snapshot.slug, ctx)), response: { status: post.status } };
  }
  async update(snapshot, ctx) {
    const post = await this.call(ctx, "POST", `/wp/v2/posts/${encodeURIComponent(ctx.publication.remote_id)}`, this.body(snapshot, ctx));
    if (post.slug !== snapshot.slug) throw new PublishError("SLUG_CONFLICT", "WordPress changed the slug (another post uses it)");
    return { remoteId: String(post.id), publicUrl: String(post.link), response: { status: post.status } };
  }
  async unpublish(ctx) {
    const post = await this.call(ctx, "POST", `/wp/v2/posts/${encodeURIComponent(ctx.publication.remote_id)}`, { status: "draft" });
    return { response: { status: post.status } };
  }
  async verify(ctx, { expect, url, slug, title }) {
    const post = await this.call(ctx, "GET", `/wp/v2/posts/${encodeURIComponent(ctx.publication.remote_id)}?context=edit`);
    const checks = [{ remote_status: post.status, slug: post.slug }];
    if (expect === "live" && (post.status !== "publish" || post.slug !== slug)) return { ok: false, checks, reason: "WordPress post is not published with the expected slug" };
    if (expect === "gone" && post.status === "publish") return { ok: false, checks, reason: "WordPress post is still published" };
    const page = await this.verifyPage(ctx, { url, expect, title, marker: false });
    checks.push(page.check);
    return { ok: page.ok, checks, reason: page.reason };
  }
}
