import "server-only";
import { pickPublic, PUBLIC_FIELDS, type PublicArticle } from "./types";

/**
 * Multi-client blog hub. One deployment serves every connected website at
 * /s/<websiteId>/blog. A client's Vercel project adds ONE rewrite:
 *   /blog/:path*  ->  https://<hub>/s/<websiteId>/blog/:path*
 * so readers and Google only ever see https://<client-domain>/blog/...
 * The website is identified by the id in the path, never by the Host header.
 */
export type SiteProfile = {
  id: string;
  name: string;
  site_url: string;
  blog_path: string;
  environment: string;
  language: string;
  phone: string;
  email: string;
  service_area: string;
};

const ID_RE = /^[a-z0-9]{15}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const q = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

function pbUrl() {
  // Production hub default: the public Bunker Rank content API (published-only rules).
  const u = (process.env.BUNKER_POCKETBASE_URL || "https://seo-pb.bunkeragent.cloud").replace(/\/+$/, "");
  if (!u) throw new Error("BUNKER_POCKETBASE_URL is missing");
  return u;
}
// Hub default: 30 s so approvals/edits show up (and publisher verification sees
// the new version) quickly; the public API is cheap and behind Cloudflare.
const revalidate = () => Number(process.env.BUNKER_REVALIDATE_SECONDS || 30);

export async function getSite(id: string): Promise<SiteProfile | null> {
  if (!ID_RE.test(id)) return null;
  const res = await fetch(`${pbUrl()}/api/bsa/public/site/${id}`, { headers: { accept: "application/json" }, next: { tags: [`bunker-content:${id}`], revalidate: revalidate() } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Site API returned ${res.status}`);
  const s = (await res.json()) as SiteProfile;
  if (!/^https:\/\//.test(s.site_url)) return null;
  return s;
}

async function pbFetch(id: string, params: Record<string, string>) {
  const qs = new URLSearchParams({ website: id, fields: PUBLIC_FIELDS.join(","), ...params });
  const res = await fetch(`${pbUrl()}/api/collections/published_content/records?${qs}`, { headers: { accept: "application/json" }, next: { tags: [`bunker-content:${id}`], revalidate: revalidate() } });
  if (!res.ok) throw new Error(`Content API returned ${res.status}`);
  const json = (await res.json()) as { items?: Record<string, unknown>[] };
  return json.items ?? [];
}

export async function listFor(id: string, limit = 100): Promise<PublicArticle[]> {
  if (!ID_RE.test(id)) return [];
  return (await pbFetch(id, { filter: 'status = "published"', sort: "-published_at", perPage: String(Math.min(limit, 200)) })).map(pickPublic);
}

export async function getFor(id: string, slug: string): Promise<PublicArticle | null> {
  if (!ID_RE.test(id) || !SLUG_RE.test(slug) || slug.length > 200) return null;
  const rows = await pbFetch(id, { filter: `status = "published" && slug = "${q(slug)}"`, perPage: "1" });
  return rows[0] ? pickPublic(rows[0]) : null;
}

/** Public URL on the CLIENT domain (what Google indexes). */
export const publicUrl = (s: SiteProfile, slug = "") => `${s.site_url}${s.blog_path}${slug ? `/${slug}` : ""}`;

/** Only staging websites (or a hub-wide staging flag) are kept out of search. */
export const isNoindex = (s: SiteProfile) => s.environment !== "production" || process.env.BUNKER_STAGING_NOINDEX === "1";

/** Hub-only deployment (e.g. blog.bunkerank.com): no single-site website id configured. */
export const isHubOnly = () => !process.env.BUNKER_WEBSITE_ID;
