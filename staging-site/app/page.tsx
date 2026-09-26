import { redirect } from "next/navigation";

export default function Home() {
  // Hub-only deployment (blog.bunkerank.com): client blogs live on each client's
  // own domain at /blog via a rewrite to /s/<websiteId>/blog. Nothing to show here.
  if (!process.env.BUNKER_WEBSITE_ID) {
    return (
      <main style={{ maxWidth: 560, margin: "15vh auto", padding: 24, fontFamily: "system-ui, sans-serif", color: "#2A2825" }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Bunker Rank</h1>
        <p style={{ color: "#6b6660" }}>Blog delivery service. Articles are published on each client&apos;s own website.</p>
      </main>
    );
  }
  redirect("/blog");
}
