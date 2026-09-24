/** Public content model — the ONLY fields a website ever receives. */
export type PublicArticle = {
  title: string;
  slug: string;
  excerpt: string;
  content: string;
  content_format?: "markdown";
  featured_image: string;
  seo_title: string;
  meta_description: string;
  canonical_url: string;
  og_title?: string;
  og_description?: string;
  schema: unknown;
  language: string;
  content_type?: string;
  published_at: string;
  updated_at: string;
  author_public_name: string;
  category: string;
  tags: string[];
  revision: string;
};

export const PUBLIC_FIELDS = ["title", "slug", "excerpt", "content", "content_format", "featured_image", "seo_title", "meta_description", "canonical_url", "og_title", "og_description", "schema", "language", "content_type", "published_at", "updated_at", "author_public_name", "category", "tags", "revision"] as const;

export function pickPublic(row: Record<string, unknown>): PublicArticle {
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_FIELDS) out[k] = row[k] ?? (k === "tags" ? [] : k === "schema" ? null : "");
  return out as PublicArticle;
}
