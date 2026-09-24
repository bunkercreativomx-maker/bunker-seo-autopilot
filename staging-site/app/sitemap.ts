import type { MetadataRoute } from "next";
import { bunkerConfig } from "@/lib/bunker-content/config";
import { listPublished } from "@/lib/bunker-content/source";

export const dynamic = "force-dynamic";

// Only published + verified content (the public API never returns anything else).
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const cfg = bunkerConfig();
  const posts = await listPublished(1000);
  return [
    { url: `${cfg.siteUrl}${cfg.blogPath}`, changeFrequency: "daily" },
    ...posts.map((p) => ({ url: `${cfg.siteUrl}${cfg.blogPath}/${p.slug}`, lastModified: p.updated_at || p.published_at })),
  ];
}
