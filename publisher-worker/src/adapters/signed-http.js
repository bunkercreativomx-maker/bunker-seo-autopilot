// Shared signed-HTTP protocol for NextJsPublisher and WebhookPublisher.
import crypto from "node:crypto";
import { PublisherAdapter, requireSecret, httpError, PublishError } from "./base.js";
import { sign, HEADERS } from "../signing.js";
import { publicPayload } from "../content.js";

export class SignedHttpPublisher extends PublisherAdapter {
  endpoint(ctx) { return ctx.website.api_endpoint; }
  async send(ctx, operation, extra = {}) {
    const secret = requireSecret(ctx);
    const body = JSON.stringify({
      operation,
      website_id: ctx.website.id,
      idempotency_key: ctx.job.idempotency_key,
      sent_at: new Date().toISOString(),
      ...extra,
    });
    const headers = { "content-type": "application/json", [HEADERS.website]: ctx.website.id, ...sign(secret, body, { nonce: crypto.randomUUID() }) };
    const res = await this.http(this.endpoint(ctx), { method: "POST", headers, body }, ctx);
    if (res.status < 200 || res.status > 299) throw httpError(res.status, "Publishing endpoint");
    const json = res.json();
    if (this.strict && (!json || typeof json !== "object")) throw new PublishError("INVALID_RESPONSE", "Publishing endpoint did not return JSON");
    return { status: res.status, json: json || {} };
  }
  async testConnection(ctx) {
    const r = await this.send(ctx, "ping");
    if (this.strict && (r.json.ok !== true || r.json.website_id !== ctx.website.id)) throw new PublishError("INVALID_RESPONSE", "Endpoint did not confirm this website identity");
    return { ok: true, detail: { status: r.status } };
  }
  article(snapshot, ctx, hash) {
    const url = this.getPublicUrl(snapshot.slug, ctx);
    const ts = new Date().toISOString();
    return {
      article_id: ctx.job.article, version: snapshot.version, revision: String(hash).slice(0, 16),
      ...publicPayload(snapshot, ctx.website, { url, publishedAt: ctx.publication?.published_at || ts, updatedAt: ts, hash }),
      canonical: undefined,
    };
  }
  async publish(snapshot, ctx, hash, operation = "publish") {
    const payload = this.article(snapshot, ctx, hash);
    const r = await this.send(ctx, operation, { article: payload, remote_id: ctx.publication?.remote_id || undefined });
    const remoteId = String(r.json.remote_id || ctx.publication?.remote_id || "");
    const returned = String(r.json.public_url || "");
    if (this.strict && !remoteId) throw new PublishError("INVALID_RESPONSE", "Endpoint did not return remote_id");
    // Prefer the URL the target reports; fall back to configuration only when none is returned.
    return { remoteId, publicUrl: returned || this.getPublicUrl(snapshot.slug, ctx), response: { status: r.status, url_source: returned ? "target" : "config" } };
  }
  update(snapshot, ctx, hash) { return this.publish(snapshot, ctx, hash, "update"); }
  async unpublish(ctx) {
    const r = await this.send(ctx, "unpublish", { article_id: ctx.job.article, remote_id: ctx.publication.remote_id, slug: ctx.publication.slug });
    return { response: { status: r.status } };
  }
  async verify(ctx, { expect, hash, url, title }) {
    const checks = [];
    const page = await this.verifyPage(ctx, { url, expect, hash, title, marker: (ctx.website.publishing_configuration || {}).verify_marker !== false });
    checks.push(page.check);
    if (!page.ok) return { ok: false, checks, reason: page.reason };
    const sm = await this.verifySitemap(ctx, { url, expect });
    checks.push(sm.check);
    return { ok: sm.ok, checks, reason: sm.reason };
  }
}

/** Next.js API route publisher (POST /api/bunker-content/publish): strict contract. */
export class NextJsPublisher extends SignedHttpPublisher {
  get name() { return "nextjs_api"; }
  get strict() { return true; }
}

/** Generic signed webhook: any 2xx accepted; remote_id/public_url optional. */
export class WebhookPublisher extends SignedHttpPublisher {
  get name() { return "webhook"; }
  get strict() { return false; }
}
