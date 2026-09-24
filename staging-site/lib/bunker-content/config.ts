import "server-only";

/**
 * Website identity. The website is identified by its Bunker website ID (set
 * at deploy time), never by the Host header a browser sends.
 */
export type BunkerConfig = {
  websiteId: string;
  siteUrl: string;
  blogPath: string;
  source: "pocketbase" | "local";
  pocketbaseUrl: string;
  localStoreDir: string;
  revalidateSeconds: number;
  siteName: string;
};

export function bunkerConfig(): BunkerConfig {
  const websiteId = process.env.BUNKER_WEBSITE_ID || "";
  if (!/^[a-z0-9]{15}$/.test(websiteId)) throw new Error("BUNKER_WEBSITE_ID is missing or invalid");
  const siteUrl = (process.env.BUNKER_SITE_URL || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(siteUrl)) throw new Error("BUNKER_SITE_URL is missing");
  return {
    websiteId,
    siteUrl,
    blogPath: (process.env.BUNKER_BLOG_PATH || "/blog").replace(/\/+$/, ""),
    source: process.env.BUNKER_CONTENT_SOURCE === "local" ? "local" : "pocketbase",
    pocketbaseUrl: (process.env.BUNKER_POCKETBASE_URL || "").replace(/\/+$/, ""),
    localStoreDir: process.env.BUNKER_LOCAL_STORE_DIR || ".data",
    revalidateSeconds: Number(process.env.BUNKER_REVALIDATE_SECONDS || 300),
    siteName: process.env.BUNKER_SITE_NAME || "Blog",
  };
}

/** Shared secrets for signed requests: current + optional previous (rotation). */
export function bunkerSecrets(): string[] {
  return [process.env.BUNKER_PUBLISH_SECRET, process.env.BUNKER_PUBLISH_SECRET_PREVIOUS].filter((s): s is string => Boolean(s && s.length >= 16));
}

export const contentTag = (websiteId: string) => `bunker-content:${websiteId}`;
