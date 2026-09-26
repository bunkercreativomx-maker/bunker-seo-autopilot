import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getSite } from "@/lib/bunker-content/hub";

// Branded shell for one client's blog. Links point to the client's real
// domain (absolute), so it works both through the Vercel rewrite and when the
// hub URL is opened directly.
export default async function SiteLayout({ children, params }: { children: ReactNode; params: Promise<{ site: string }> }) {
  const { site } = await params;
  const s = await getSite(site);
  if (!s) notFound();
  const tel = s.phone.replace(/[^\d+]/g, "");
  return (
    <div className="hub">
      {s.environment !== "production" ? <div className="banner">Vista de prueba (staging) — no aparece en Google.</div> : null}
      <header className="hub-top">
        <a className="hub-brand" href={s.site_url}>{s.name}</a>
        <nav className="hub-nav">
          <a href={`${s.site_url}${s.blog_path}`}>Blog</a>
          <a href={s.site_url}>Sitio web</a>
          {tel ? <a className="hub-cta" href={`tel:${tel}`}>Llamar {s.phone}</a> : null}
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
