import type { ReactNode } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSite } from "@/lib/bunker-content/hub";
import { t } from "@/lib/bunker-content/i18n";

// Branded shell for one client's blog. Links point to the client's real
// domain (absolute), so it works both through the Vercel rewrite and when the
// hub URL is opened directly.
// Connection marker: lets Bunker Rank verify that <client>.com/blog is really
// served by this hub for THIS website (not the client's own catch-all page).
export async function generateMetadata({ params }: { params: Promise<{ site: string }> }): Promise<Metadata> {
  const { site } = await params;
  return { other: { "bunker-hub": site } };
}

export default async function SiteLayout({ children, params }: { children: ReactNode; params: Promise<{ site: string }> }) {
  const { site } = await params;
  const s = await getSite(site);
  if (!s) notFound();
  const L = t(s.language);
  const tel = s.phone.replace(/[^\d+]/g, "");
  return (
    <div className="hub" lang={s.language?.startsWith("en") ? "en" : "es"}>
      {s.environment !== "production" ? <div className="banner">{L.staging}</div> : null}
      <header className="hub-top">
        <a className="hub-brand" href={s.site_url}>{s.name}</a>
        <nav className="hub-nav">
          <a href={`${s.site_url}${s.blog_path}`}>Blog</a>
          <a href={s.site_url}>{L.website}</a>
          {tel ? <a className="hub-cta" href={`tel:${tel}`}>{L.call} {s.phone}</a> : null}
        </nav>
      </header>
      <div className="hub-main">{children}</div>
      <footer className="hub-foot">
        <span>© {new Date().getFullYear()} {s.name}</span>
        {s.service_area ? <span> · {s.service_area}</span> : null}
      </footer>
    </div>
  );
}
