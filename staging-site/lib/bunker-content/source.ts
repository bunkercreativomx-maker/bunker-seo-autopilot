import "server-only";
import { bunkerConfig, contentTag } from "./config";
import { localGet, localList } from "./local-store";
import { pickPublic, PUBLIC_FIELDS, type PublicArticle } from "./types";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const q = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/**
 * PocketBase CMS mode: anonymous read of the public collection. The collection
 * rule only returns rows with status = "published" for the website named in
 * ?website=, and internal fields are hidden server-side.
 */
async function pbFetch(params: Record<string, string>): Promise<Record<string, unknown>[]> {
  const cfg = bunkerConfig();
  const qs = new URLSearchParams({ website: cfg.websiteId, fields: PUBLIC_FIELDS.join(","), ...params });
  const res = await fetch(`${cfg.pocketbaseUrl}/api/collections/published_content/records?${qs}`, {
    headers: { accept: "application/json" },
    next: { tags: [contentTag(cfg.websiteId)], revalidate: cfg.revalidateSeconds },
  });
  if (!res.ok) throw new Error(`Content API returned ${res.status}`);
  const json = (await res.json()) as { items?: Record<string, unknown>[] };
  return json.items ?? [];
}

export async function listPublished(limit = 100): Promise<PublicArticle[]> {
  const cfg = bunkerConfig();
  if (cfg.source === "local") return (await localList()).slice(0, limit);
  const rows = await pbFetch({ filter: 'status = "published"', sort: "-published_at", perPage: String(Math.min(limit, 200)) });
  return rows.map(pickPublic);
}

export async function getPublished(slug: string): Promise<PublicArticle | null> {
  if (!SLUG_RE.test(slug) || slug.length > 200) return null;
  const cfg = bunkerConfig();
  if (cfg.source === "local") return localGet(slug);
  const rows = await pbFetch({ filter: `status = "published" && slug = "${q(slug)}"`, perPage: "1" });
  return rows[0] ? pickPublic(rows[0]) : null;
}

export function articleUrl(slug: string): string {
  const cfg = bunkerConfig();
  return `${cfg.siteUrl}${cfg.blogPath}/${slug}`;
}
