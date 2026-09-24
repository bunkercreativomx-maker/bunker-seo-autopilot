// Public content model + safe rendering helpers (no HTML passthrough).
import crypto from "node:crypto";

export const SNAPSHOT_FIELDS = ["title", "slug", "seo_title", "meta_description", "excerpt", "content", "og_title", "og_description", "canonical_url", "featured_image", "structured_data", "language", "content_type"];
export const PUBLIC_FIELDS = ["title", "slug", "excerpt", "content", "featured_image", "seo_title", "meta_description", "canonical_url", "og_title", "og_description", "schema", "language", "content_type", "published_at", "updated_at", "author_public_name", "category", "tags"];

// Must match pb_hooks/bsa_publish.js stableStringify/snapshotHash byte-for-byte.
export function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (typeof value === "object") return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
  return JSON.stringify(value);
}

export function snapshotOf(article) {
  const out = { version: Number(article.current_version || 0) };
  for (const f of SNAPSHOT_FIELDS) {
    const v = article[f];
    if (f === "structured_data") out[f] = v === undefined || v === "" ? null : v;
    else out[f] = String(v === undefined || v === null ? "" : v);
  }
  return out;
}

export const snapshotHash = (snapshot) => crypto.createHash("sha256").update(stableStringify(snapshot)).digest("hex");

export function publicUrl(website, slug) {
  return String(website.base_url || "").replace(/\/+$/, "") + (website.blog_path || "") + "/" + slug;
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

/** Canonical: approved canonical only if it points at this website; else the real public URL. */
export function canonicalFor(snapshot, website, url) {
  const c = String(snapshot.canonical_url || "");
  const allowed = (website.allowed_domains || []).map((d) => String(d).toLowerCase());
  return c && /^https?:\/\//i.test(c) && allowed.includes(hostOf(c)) ? c : url;
}

/** Whitelisted public payload built ONLY from the approved snapshot. */
export function publicPayload(snapshot, website, { url, publishedAt, updatedAt, hash }) {
  const cfg = website.publishing_configuration || {};
  const image = String(snapshot.featured_image || "");
  return {
    title: snapshot.title,
    slug: snapshot.slug,
    excerpt: snapshot.excerpt,
    content: snapshot.content,
    content_format: "markdown",
    featured_image: /^https:\/\//i.test(image) ? image : "",
    seo_title: snapshot.seo_title || snapshot.title,
    meta_description: snapshot.meta_description,
    canonical_url: canonicalFor(snapshot, website, url),
    og_title: snapshot.og_title || snapshot.seo_title || snapshot.title,
    og_description: snapshot.og_description || snapshot.meta_description,
    schema: sanitizeSchema(snapshot.structured_data),
    language: snapshot.language,
    content_type: snapshot.content_type,
    published_at: publishedAt,
    updated_at: updatedAt,
    author_public_name: String(cfg.author_public_name || ""),
    category: "",
    tags: [],
    revision: String(hash || "").slice(0, 16),
  };
}

/** Keep only JSON data (no functions); drop keys that look internal. */
export function sanitizeSchema(value) {
  if (value === null || value === undefined || value === "") return null;
  const walk = (v, depth) => {
    if (depth > 12) return null;
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) { if (/^_|^(internal|claims?|research|qa|notes?|ai_usage|cost|facts?)$/i.test(k)) continue; out[k] = walk(x, depth + 1); }
      return out;
    }
    if (typeof v === "string") return v.slice(0, 5000);
    if (typeof v === "number" || typeof v === "boolean") return v;
    return null;
  };
  return walk(value, 0);
}

/** JSON-LD safe for embedding inside <script type="application/ld+json">. */
export function jsonLdString(schema) {
  return JSON.stringify(schema ?? null).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function safeHref(href) {
  const v = String(href).trim();
  if (/^https?:\/\//i.test(v) || (v.startsWith("/") && !v.startsWith("//")) || v.startsWith("#")) return v;
  return null;
}

function inline(text) {
  // Escape FIRST: raw HTML in the source can never become markup.
  let out = "";
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;
  let last = 0;
  let m;
  while ((m = pattern.exec(text))) {
    out += escapeHtml(text.slice(last, m.index));
    if (m[1] !== undefined) {
      const href = safeHref(m[2]);
      out += href ? `<a href="${escapeHtml(href)}"${/^https?:/i.test(href) ? ' rel="noopener noreferrer"' : ""}>${escapeHtml(m[1])}</a>` : escapeHtml(m[1]);
    } else if (m[3] !== undefined) out += `<strong>${escapeHtml(m[3])}</strong>`;
    else if (m[4] !== undefined) out += `<em>${escapeHtml(m[4])}</em>`;
    else if (m[5] !== undefined) out += `<code>${escapeHtml(m[5])}</code>`;
    last = pattern.lastIndex;
  }
  return out + escapeHtml(text.slice(last));
}

/** Minimal Markdown → sanitized HTML (headings, paragraphs, lists, quotes, links, emphasis). */
export function markdownToSafeHtml(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let para = [];
  let list = null;
  const flush = () => {
    if (para.length) html.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
    if (list) html.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.type}>`);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const b = /^\s*[-*+]\s+(.*)$/.exec(line);
    const n = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) { flush(); continue; }
    if (h) { flush(); html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (b || n) {
      if (para.length) { html.push(`<p>${inline(para.join(" "))}</p>`); para = []; }
      const type = b ? "ul" : "ol";
      if (!list || list.type !== type) { if (list) html.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.type}>`); list = { type, items: [] }; }
      list.items.push((b || n)[1]);
      continue;
    }
    if (line.startsWith(">")) { flush(); html.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`); continue; }
    if (list) { html.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.type}>`); list = null; }
    para.push(line.trim());
  }
  flush();
  return html.join("\n");
}
