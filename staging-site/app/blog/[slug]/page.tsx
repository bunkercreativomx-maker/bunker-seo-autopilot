import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { bunkerConfig } from "@/lib/bunker-content/config";
import { Markdown } from "@/lib/bunker-content/markdown";
import { articleMetadata, jsonLd, publicSchema } from "@/lib/bunker-content/seo";
import { articleUrl, getPublished } from "@/lib/bunker-content/source";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const a = await getPublished(slug);
  if (!a) return { title: "Not found", robots: { index: false } };
  return articleMetadata(a, articleUrl(a.slug), bunkerConfig().siteName);
}

export default async function ArticlePage({ params }: Props) {
  const { slug } = await params;
  const a = await getPublished(slug);
  if (!a) notFound();
  const ld = jsonLd(publicSchema(a.schema));
  return (
    <article>
      {ld ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: ld }} /> : null}
      <h1>{a.title}</h1>
      <p className="meta">
        Publicado <time dateTime={a.published_at}>{new Date(a.published_at).toLocaleDateString("es-MX")}</time>
        {a.updated_at && a.updated_at !== a.published_at ? <> · Actualizado <time dateTime={a.updated_at}>{new Date(a.updated_at).toLocaleDateString("es-MX")}</time></> : null}
        {a.author_public_name ? <> · {a.author_public_name}</> : null}
      </p>
      {a.featured_image ? <img src={a.featured_image} alt="" style={{ maxWidth: "100%", borderRadius: 12 }} /> : null}
      <Markdown source={a.content} />
    </article>
  );
}
