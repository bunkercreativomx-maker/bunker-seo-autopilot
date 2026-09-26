import { getSite, isNoindex, listFor, publicUrl } from "@/lib/bunker-content/hub";

export const dynamic = "force-dynamic";

const x = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Client-facing: https://<client>/blog/sitemap.xml (via the rewrite).
// Staging websites return an empty sitemap so nothing gets indexed.
export async function GET(_req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  const s = await getSite(site);
  if (!s) return new Response("Not found", { status: 404 });
  const posts = isNoindex(s) ? [] : await listFor(site, 1000);
  const urls = [
    `<url><loc>${x(publicUrl(s))}</loc><changefreq>daily</changefreq></url>`,
    ...posts.map((p) => `<url><loc>${x(publicUrl(s, p.slug))}</loc>${p.updated_at || p.published_at ? `<lastmod>${x(new Date(p.updated_at || p.published_at).toISOString())}</lastmod>` : ""}</url>`),
  ];
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${isNoindex(s) ? "" : urls.join("")}</urlset>\n`;
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=300" } });
}
