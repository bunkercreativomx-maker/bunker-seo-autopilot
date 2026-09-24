import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: process.env.BUNKER_SITE_URL ? new URL(process.env.BUNKER_SITE_URL) : undefined,
  title: { default: process.env.BUNKER_SITE_NAME || "Bunker Publishing Sandbox", template: `%s` },
  robots: process.env.BUNKER_STAGING_NOINDEX === "1" ? { index: false, follow: false } : undefined,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>
        {process.env.BUNKER_STAGING_NOINDEX === "1" ? <div className="banner">Staging sandbox — Bunker SEO Autopilot Phase 5. Not a production website.</div> : null}
        <main>{children}</main>
      </body>
    </html>
  );
}
