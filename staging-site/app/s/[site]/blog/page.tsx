import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSite, isNoindex, listFor, publicUrl } from "@/lib/bunker-content/hub";
import { t } from "@/lib/bunker-content/i18n";
import { themeFor } from "@/lib/bunker-content/themes";
import { tel as telOf } from "@/lib/bunker-content/branded";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ site: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { site } = await params;
  const s = await getSite(site);
  if (!s) return { title: "Not found", robots: { index: false } };
  return {
    title: `Blog — ${s.name}`,
    description: t(s.language).desc(s.name, s.service_area),
    alternates: { canonical: publicUrl(s) },
    robots: isNoindex(s) ? { index: false, follow: false } : undefined,
  };
}

export default async function HubIndex({ params }: Props) {
  const { site } = await params;
  const s = await getSite(site);
  if (!s) notFound();
  const posts = await listFor(site);
  const L = t(s.language);
  const fmt = (d: string) => (d ? new Date(d).toLocaleDateString(L.locale, { day: "numeric", month: "long", year: "numeric" }) : "");
  const th = themeFor(site);
  const ld = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Blog",
    name: `Blog — ${s.name}`,
    url: publicUrl(s),
    inLanguage: s.language || undefined,
    publisher: { "@type": "Organization", name: s.name, url: s.site_url, ...(s.phone ? { telephone: s.phone } : {}) },
    blogPost: posts.slice(0, 20).map((p) => ({
      "@type": "BlogPosting",
      headline: p.title,
      url: publicUrl(s, p.slug),
      ...(p.published_at ? { datePublished: p.published_at } : {}),
      ...(p.featured_image ? { image: p.featured_image } : {}),
    })),
  }).replace(/</g, "\\u003c");
  const ldTag = <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: ld }} />;
  if (th) {
    const tn = telOf(s.phone);
    return (
      <>
        {ldTag}
        <section className="bh-hero" style={th.heroImage ? { backgroundImage: `linear-gradient(100deg, rgba(0,46,91,.96) 35%, rgba(0,46,91,.72)), url(${th.heroImage})` } : undefined}>
          <div className="bh-in">
            <span className="bh-kicker">Blog</span>
            <h1>{th.heroTitle[0]} <span>{th.heroTitle[1]}</span></h1>
            <p>{th.heroSub}</p>
          </div>
        </section>
        <section className="bh-list">
          <div className="bh-in">
            {posts.length === 0 ? (
              <div className="bh-empty">
                <div className="bh-empty-ic" aria-hidden>❄</div>
                <h2>{L.empty}</h2>
                <p>{th.ctaText}</p>
                <a className="bh-btn bh-btn-accent" href={`tel:${tn}`}>{L.call} {s.phone}</a>
              </div>
            ) : (
              <div className="bh-grid">
                {posts.map((p) => (
                  <a key={p.slug} className="bh-card" href={publicUrl(s, p.slug)}>
                    <div className="bh-card-img">{p.featured_image ? <img src={p.featured_image} alt="" loading="lazy" /> : <div className="bh-ph" aria-hidden>❄</div>}</div>
                    <div className="bh-card-body">
                      <div className="bh-meta"><span>{fmt(p.published_at)}</span><span>{th.author}</span></div>
                      <h2>{p.title}</h2>
                      {p.excerpt ? <p>{p.excerpt}</p> : null}
                      <span className="bh-more">{th.readMore} →</span>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>
        </section>
      </>
    );
  }
  return (
    <section>
      {ldTag}
      <div className="hub-hero">
        <h1>Blog</h1>
        <p>{L.heroSub(s.name)}</p>
      </div>
      {posts.length === 0 ? <p className="meta">{L.empty}</p> : null}
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
