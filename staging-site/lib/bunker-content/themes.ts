// Per-client look for the blog hub, so <client>.com/blog feels like the rest of
// the client's website (same header, colors, CTAs and footer). Only facts the
// client publishes on their own site go here (logo, phone, email, nav links).
// Sites without a theme keep the neutral shell.
export type HubTheme = {
  logo: string;
  logoAlt: string;
  badge?: string;
  colors: { primary: string; accent: string; hot: string; bar: string };
  nav: { label: string; href: string }[];
  phoneLabel: string;
  schedule: { label: string; href: string };
  book: { label: string; href: string };
  heroTitle: [string, string];
  heroSub: string;
  heroImage?: string;
  footerBlurb: string;
  email?: string;
  area?: string;
  facebook?: string;
  quickLinks: { label: string; href: string }[];
  ctaTitle: string;
  ctaText: string;
  author: string;
  readMore: string;
};

const EMPIRE = "https://weneedair.com";

const THEMES: Record<string, HubTheme> = {
  // Empire Refrigeration — weneedair.com
  ls7apwu0ozsni1t: {
    logo: `${EMPIRE}/assets/logo.png`,
    logoAlt: "Empire Refrigeration - Air Conditioning & Heating El Paso",
    badge: `${EMPIRE}/assets/local-loved-trusted.png`,
    colors: { primary: "#002e5b", accent: "#2ab8f9", hot: "#e1005a", bar: "#facc15" },
    nav: [
      { label: "Home", href: `${EMPIRE}/` },
      { label: "About", href: `${EMPIRE}/about` },
      { label: "Residential", href: `${EMPIRE}/services` },
      { label: "Commercial", href: `${EMPIRE}/commercial` },
      { label: "Financing", href: `${EMPIRE}/financing` },
      { label: "Blog", href: `${EMPIRE}/blog` },
      { label: "Contact", href: `${EMPIRE}/contact` },
    ],
    phoneLabel: "CALL 915.787.0747 TODAY!",
    schedule: { label: "SCHEDULE NOW", href: `${EMPIRE}/contact` },
    book: { label: "BOOK NOW!", href: "tel:+19157870747" },
    heroTitle: ["Expert HVAC", "Insights"],
    heroSub: "Stay cool, stay warm, and stay informed with the latest tips from our certified technicians.",
    heroImage: `${EMPIRE}/assets/hot-weather-el-paso.webp`,
    footerBlurb: "Reliable air conditioning and heating services in El Paso. We keep you comfortable all year round with expert installation, repair, and maintenance.",
    email: "contact@weneedair.com",
    area: "El Paso, Texas & Surrounding Areas",
    facebook: "https://www.facebook.com/WeNeedAir",
    quickLinks: [
      { label: "Home", href: `${EMPIRE}/` },
      { label: "About Us", href: `${EMPIRE}/about` },
      { label: "Residential Services", href: `${EMPIRE}/services` },
      { label: "Commercial Services", href: `${EMPIRE}/commercial` },
      { label: "Financing", href: `${EMPIRE}/financing` },
      { label: "Blog", href: `${EMPIRE}/blog` },
      { label: "Contact", href: `${EMPIRE}/contact` },
    ],
    ctaTitle: "Need AC or heating help today?",
    ctaText: "Our certified technicians are ready to keep your home comfortable.",
    author: "Empire Team",
    readMore: "Read More",
  },
};

export const themeFor = (siteId: string): HubTheme | null => THEMES[siteId] ?? null;
