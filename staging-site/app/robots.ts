import type { MetadataRoute } from "next";

// /blog is explicitly crawlable. The staging deployment is kept out of search
// with X-Robots-Tag/meta noindex (BUNKER_STAGING_NOINDEX=1), not robots.txt,
// so a crawler that respects robots still sees the noindex directive.
export default function robots(): MetadataRoute.Robots {
  const site = (process.env.BUNKER_SITE_URL || "").replace(/\/+$/, "");
  // Hub-only host: allow crawling of /s/ pages (they carry canonical URLs on the client domain).
  return { rules: [{ userAgent: "*", allow: ["/", "/blog"] }], sitemap: site ? `${site}/sitemap.xml` : undefined };
}
