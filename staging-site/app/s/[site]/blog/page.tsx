import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSite, isNoindex, listFor, publicUrl } from "@/lib/bunker-content/hub";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ site: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { site } = await params;
  const s = await getSite(site);
  if (!s) return { title: "Not found", robots: { index: false } };
  return {
    title: `Blog — ${s.name}`,
    description: `Artículos y guías de ${s.name}${s.service_area ? ` en ${s.service_area}` : ""}.`,
    alternates: { canonical: publicUrl(s) },
    robots: isNoindex(s) ? { index: false, follow: false } : undefined,
  };
}

export default async function HubIndex({ params }: Props) {
  const { site } = await params;
  const s = await getSite(site);
  if (!s) notFound();
  const posts = await listFor(site);
  const fmt = (d: string) => (d ? new Date(d).toLocaleDateString(s.language?.startsWith("en") ? "en-US" : "es-MX", { day: "numeric", month: "long", year: "numeric" }) : "");
  return (
    <section>
      <div className="hub-hero">
        <h1>Blog</h1>
        <p>Guías y respuestas claras de {s.name}.</p>
      </div>
      {posts.length === 0 ? <p className="meta">Pronto publicaremos nuestros primeros artículos.</p> : null}
      <div className="hub-grid">
        {posts.map((p) => (
          <a key={p.slug} className="hub-card" href={publicUrl(s, p.slug)}>
            {p.featured_image ? <img src={p.featured_image} alt="" loading="lazy" /> : <div className="hub-ph" aria-hidden />}
            <div className="hub-card-body">
              <h2>{p.title}</h2>
              {p.excerpt ? <p>{p.excerpt}</p> : null}
              <span className="meta">{fmt(p.published_at)}</span>
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}
