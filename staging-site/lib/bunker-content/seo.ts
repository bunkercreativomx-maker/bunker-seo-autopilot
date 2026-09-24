import type { Metadata } from "next";
import type { PublicArticle } from "./types";

/** Metadata strictly from the approved fields — nothing is generated here. */
export function articleMetadata(a: PublicArticle, url: string, siteName: string): Metadata {
  const title = a.seo_title || a.title;
  const description = a.meta_description || a.excerpt;
  const images = a.featured_image ? [{ url: a.featured_image }] : undefined;
  return {
    title,
    description,
    alternates: { canonical: a.canonical_url || url },
    openGraph: { type: "article", url, siteName, title: a.og_title || title, description: a.og_description || description, publishedTime: a.published_at, modifiedTime: a.updated_at, locale: a.language || undefined, images },
    twitter: { card: images ? "summary_large_image" : "summary", title: a.og_title || title, description: a.og_description || description },
    other: { "bunker-content-revision": a.revision, "article:published_time": a.published_at, "article:modified_time": a.updated_at },
  };
}

/**
 * JSON-LD serialized so no string value can terminate the <script> element or
 * open HTML: <, >, & and line separators are escaped as JSON unicode escapes.
 */
export function jsonLd(schema: unknown): string | null {
  if (!schema || typeof schema !== "object") return null;
  return JSON.stringify(schema).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const ALLOWED_TYPES = new Set(["Article", "BlogPosting", "Service", "BreadcrumbList", "FAQPage", "LocalBusiness", "Organization", "WebPage", "HowTo"]);

/** Keep only schema.org objects of known types (drops anything else). */
export function publicSchema(schema: unknown): unknown {
  const list = Array.isArray(schema) ? schema : schema && typeof schema === "object" && "@graph" in (schema as object) ? (schema as { "@graph": unknown[] })["@graph"] : [schema];
  const kept = (list || []).filter((s) => s && typeof s === "object" && ALLOWED_TYPES.has(String((s as Record<string, unknown>)["@type"])));
  if (!kept.length) return null;
  return kept.length === 1 ? { "@context": "https://schema.org", ...(kept[0] as object) } : { "@context": "https://schema.org", "@graph": kept };
}
