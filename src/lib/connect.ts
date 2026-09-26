// Bunker Rank blog hub: client sites rewrite /blog here (see pb_hooks/bsa_connect.js).
export const BLOG_HUB = "https://blog.bunkerank.com";

export function connectSnippets(websiteId: string) {
  const hub = `${BLOG_HUB}/s/${websiteId}/blog`;
  const rules = [
    { source: "/blog", destination: hub },
    { source: "/blog/:path*", destination: `${hub}/:path*` },
  ];
  return {
    file: JSON.stringify({ rewrites: rules }, null, 2),
    lines: rules.map((r) => "    " + JSON.stringify(r).replace(/":/g, '": ').replace(/,"/g, ', "') + ",").join("\n"),
  };
}
