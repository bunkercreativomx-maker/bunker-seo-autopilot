import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Markdown } from "@/lib/bunker-content/markdown";
import { articleMetadata, jsonLd, publicSchema } from "@/lib/bunker-content/seo";
import { getFor, getSite, isNoindex, publicUrl } from "@/lib/bunker-content/hub";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ site: string; slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { site, slug } = await params;
  const s = await getSite(site);
  const a = s ? await getFor(site, slug) : null;
  if (!s || !a) return { title: "Not found", robots: { index: false } };
  const m = articleMetadata(a, publicUrl(s, a.slug), s.name);
  return { ...m, robots: isNoindex(s) ? { index: false, follow: false } : undefined };
}

export default async function HubArticle({ params }: Props) {
  const { site, slug } = await params;
  const s = await getSite(site);
  if (!s) notFound();
  const a = await getFor(site, slug);
  if (!a) notFound();
  const ld = jsonLd(publicSchema(a.schema));
  const loc = s.language?.startsWith("en") ? "en-US" : "es-MX";
  const tel = s.phone.replace(/[^\d+]/g, "");
  return (
    <article className="hub-article">
      {ld ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: ld }} /> : null}
      <a className="hub-back" href={publicUrl(s)}>← Blog</a>
      <h1>{a.title}</h1>
      <p className="meta">
        <time dateTime={a.published_at}>{new Date(a.published_at).toLocaleDateString(loc, { day: "numeric", month: "long", year: "numeric" })}</time>
        {a.updated_at && a.updated_at.slice(0, 10) !== a.published_at.slice(0, 10) ? <> · Actualizado <time dateTime={a.updated_at}>{new Date(a.updated_at).toLocaleDateString(loc)}</time></> : null}
      </p>
      {a.featured_image ? <img className="hub-hero-img" src={a.featured_image} alt="" /> : null}
      <div className="hub-prose"><Markdown source={a.content} /></div>
      <aside className="hub-box">
        <strong>{s.name}</strong>
        <p>¿Tienes dudas sobre este tema? Con gusto te ayudamos.</p>
        <div className="hub-box-actions">
          {tel ? <a className="hub-cta" href={`tel:${tel}`}>Llamar {s.phone}</a> : null}
          <a className="hub-link" href={s.site_url}>Visitar el sitio</a>
        </div>
      </aside>
    </article>
  );
}
