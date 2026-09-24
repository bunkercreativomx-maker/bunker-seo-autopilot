// PublisherAdapter contract. Every adapter implements:
//   testConnection()                      → { ok, detail }   (never publishes)
//   publish(snapshot, ctx)                → { remoteId, publicUrl, response }
//   update(snapshot, ctx)                 → { remoteId, publicUrl, response }
//   unpublish(ctx)                        → { response }
//   verify(ctx, { expect: "live"|"gone", hash, slug }) → { ok, checks, reason }
//   getPublicUrl(slug, ctx)               → string
// ctx = { website, integration, publication, secrets, job, env }
// The engine never imports a framework: adapters are the only place that
// knows how a target stores content.
import { request, httpError, PublishError } from "../net.js";
import { publicUrl } from "../content.js";

export class PublisherAdapter {
  constructor(deps = {}) { this.deps = deps; this.env = deps.env || process.env; }
  get name() { return "base"; }
  getPublicUrl(slug, ctx) { return publicUrl(ctx.website, slug); }
  allowed(ctx) { return ctx.website.allowed_domains || []; }
  async http(url, opts, ctx) { return request(url, { ...opts, allowedDomains: this.allowed(ctx), env: this.env }); }
  /** GET the public page and compare against expectations. */
  async verifyPage(ctx, { url, expect, hash, title, marker = true }) {
    const res = await this.http(url, { method: "GET", headers: { accept: "text/html" } }, ctx);
    if (expect === "gone") {
      const ok = res.status === 404 || res.status === 410;
      return { ok, check: { page: url, status: res.status }, reason: ok ? "" : `Page still returns ${res.status}` };
    }
    if (res.status !== 200) return { ok: false, check: { page: url, status: res.status }, reason: `Public page returned ${res.status}` };
    const revision = /<meta[^>]+name=["']bunker-content-revision["'][^>]+content=["']([a-f0-9]{8,64})["']/i.exec(res.text)?.[1] || "";
    if (marker && hash && revision !== String(hash).slice(0, 16)) return { ok: false, check: { page: url, status: 200, revision }, reason: revision ? "Public page shows a different version" : "Public page lacks the expected content revision marker" };
    if (!marker && title && !res.text.includes(escapeForMatch(title))) return { ok: false, check: { page: url, status: 200 }, reason: "Public page does not contain the article title" };
    return { ok: true, check: { page: url, status: 200, revision } };
  }
  async verifySitemap(ctx, { url, expect }) {
    const cfg = ctx.website.publishing_configuration || {};
    if (cfg.verify_sitemap === false) return { ok: true, check: { sitemap: "skipped" } };
    const sm = cfg.sitemap_url || String(ctx.website.base_url).replace(/\/+$/, "") + "/sitemap.xml";
    const res = await this.http(sm, { method: "GET", headers: { accept: "application/xml,text/xml" } }, ctx);
    if (res.status !== 200) return { ok: false, check: { sitemap: sm, status: res.status }, reason: `Sitemap returned ${res.status}` };
    const present = res.text.includes(`<loc>${xmlEscape(url)}</loc>`);
    const ok = expect === "live" ? present : !present;
    return { ok, check: { sitemap: sm, present }, reason: ok ? "" : (present ? "URL still listed in sitemap" : "URL missing from sitemap") };
  }
}

const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeForMatch = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function requireSecret(ctx) {
  if (!ctx.secrets?.length) throw new PublishError("NOT_CONFIGURED", "Publisher credentials are not configured");
  return ctx.secrets[0];
}

export { request, httpError, PublishError };
