import type { Metadata } from "next";
import Link from "next/link";
import { bunkerConfig } from "@/lib/bunker-content/config";
import { listPublished } from "@/lib/bunker-content/source";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const cfg = bunkerConfig();
  return { title: `Blog — ${cfg.siteName}`, alternates: { canonical: `${cfg.siteUrl}${cfg.blogPath}` } };
}

export default async function BlogIndex() {
  const cfg = bunkerConfig();
  const posts = await listPublished();
  return (
    <section>
      <h1>Blog</h1>
      {posts.length === 0 ? <p className="meta">No published articles yet.</p> : null}
      {posts.map((p) => (
        <Link key={p.slug} className="card" href={`${cfg.blogPath}/${p.slug}`}>
          <h2>{p.title}</h2>
          {p.excerpt ? <p>{p.excerpt}</p> : null}
          <span className="meta">{new Date(p.published_at).toLocaleDateString("es-MX")}</span>
        </Link>
      ))}
    </section>
  );
}
