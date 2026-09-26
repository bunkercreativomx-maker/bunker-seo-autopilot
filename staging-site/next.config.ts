import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // When served through <client>.com/blog (Vercel rewrite), /_next assets must
  // load from the hub itself, not from the client's domain.
  assetPrefix: process.env.BUNKER_ASSET_PREFIX || (process.env.VERCEL_ENV === "production" && !process.env.BUNKER_WEBSITE_ID ? "https://blog.bunkerank.com" : undefined),
  turbopack: { root: __dirname },
  async headers() {
    // Staging must never compete in search with the real website.
    if (process.env.BUNKER_STAGING_NOINDEX !== "1") return [];
    return [{ source: "/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] }];
  },
};

export default nextConfig;
