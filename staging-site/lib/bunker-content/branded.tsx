import type { CSSProperties, ReactNode } from "react";
import type { HubTheme } from "./themes";
import type { SiteProfile } from "./hub";
import { t as tr } from "./i18n";

const Phone = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>
);
const Cal = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
);
const Mail = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>
);
const Pin = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>
);

export const tel = (phone: string) => phone.replace(/[^\d+]/g, "");

export function themeStyle(th: HubTheme): CSSProperties {
  return { ["--b-primary" as string]: th.colors.primary, ["--b-accent" as string]: th.colors.accent, ["--b-hot" as string]: th.colors.hot, ["--b-bar" as string]: th.colors.bar, ["--b-hero-accent" as string]: th.heroAccent ?? th.colors.accent };
}

export function BrandedShell({ th, s, staging, children }: { th: HubTheme; s: SiteProfile; staging?: string; children: ReactNode }) {
  const t = tel(s.phone);
  const L = tr(s.language);
  return (
    <div className="hub bh" style={themeStyle(th)} lang={s.language?.startsWith("en") ? "en" : "es"}>
      {staging ? <div className="banner">{staging}</div> : null}
      <header className="bh-head">
        <div className="bh-bar">
          <a className="bh-call" href={`tel:${t}`}><Phone /> <span>{th.phoneLabel}</span></a>
          <a className="bh-sched" href={th.schedule.href}><Cal /> <span>{th.schedule.label}</span></a>
        </div>
        <div className="bh-nav-wrap">
          <div className="bh-nav-in">
            <a href={th.nav[0]?.href || s.site_url} className="bh-logo"><img src={th.logo} alt={th.logoAlt} /></a>
            {th.badge ? <img className="bh-badge" src={th.badge} alt="" /> : null}
            <nav className="bh-nav">
              {th.nav.map((n) => <a key={n.href} href={n.href} className={n.label === "Blog" ? "on" : undefined}>{n.label}</a>)}
            </nav>
            <a className="bh-book" href={th.book.href}>{th.book.label}</a>
            <details className="bh-mnav">
              <summary aria-label="Menu"><span /><span /><span /></summary>
              <div className="bh-mnav-panel">{th.nav.map((n) => <a key={n.href} href={n.href}>{n.label}</a>)}</div>
            </details>
          </div>
        </div>
      </header>
      <div className="bh-main">{children}</div>
      <section className="bh-cta">
        <div className="bh-in">
          <div>
            <h2>{th.ctaTitle}</h2>
            <p>{th.ctaText}</p>
          </div>
          <div className="bh-cta-actions">
            <a className="bh-btn bh-btn-accent" href={`tel:${t}`}><Phone /> {s.phone}</a>
            <a className="bh-btn bh-btn-hot" href={th.schedule.href}><Cal /> {th.schedule.label}</a>
          </div>
        </div>
      </section>
      <footer className="bh-foot">
        <div className="bh-in bh-foot-grid">
          <div>
            <img className="bh-foot-logo" src={th.logo} alt={th.logoAlt} />
            <p>{th.footerBlurb}</p>
            {th.facebook ? <a className="bh-fb" href={th.facebook} target="_blank" rel="noopener noreferrer">Facebook</a> : null}
          </div>
          <div>
            <h3>{L.contact}</h3>
            <ul className="bh-contact">
              <li><span className="bh-ic"><Phone /></span><a href={`tel:${t}`}>{s.phone}</a></li>
              {th.email ? <li><span className="bh-ic"><Mail /></span><a href={`mailto:${th.email}`}>{th.email}</a></li> : null}
              {th.area ? <li><span className="bh-ic"><Pin /></span><span>{th.area}</span></li> : null}
            </ul>
          </div>
          <div>
            <h3>{L.links}</h3>
            <ul className="bh-links">{th.quickLinks.map((l) => <li key={l.href}><a href={l.href}>{l.label}</a></li>)}</ul>
          </div>
        </div>
        <div className="bh-in bh-copy">© {new Date().getFullYear()} {s.name}. {L.rights}</div>
      </footer>
    </div>
  );
}
