// UI strings for the client blog shell, in the website's own language.
const ES = {
  staging: "Vista de prueba (staging) — no aparece en Google.",
  website: "Sitio web", call: "Llamar", heroSub: (n: string) => `Guías y respuestas claras de ${n}.`,
  empty: "Pronto publicaremos nuestros primeros artículos.",
  desc: (n: string, a: string) => `Artículos, guías prácticas y respuestas claras de ${n}${a ? ` en ${a}` : ""}. Consejos útiles para tomar mejores decisiones.`,
  updated: "Actualizado", boxText: "¿Tienes dudas sobre este tema? Con gusto te ayudamos.", visit: "Visitar el sitio",
  contact: "Contacto", links: "Enlaces r\u00e1pidos", rights: "Todos los derechos reservados.",
  locale: "es-MX",
};
const EN: typeof ES = {
  staging: "Preview (staging) — not shown on Google.",
  website: "Website", call: "Call", heroSub: (n: string) => `Clear guides and answers from ${n}.`,
  empty: "Our first articles are coming soon.",
  desc: (n: string, a: string) => `Articles, practical guides and clear answers from ${n}${a ? ` in ${a}` : ""}. Useful tips to help you make better decisions.`,
  updated: "Updated", boxText: "Questions about this topic? We're happy to help.", visit: "Visit the website",
  contact: "Contact Us", links: "Quick Links", rights: "All rights reserved.",
  locale: "en-US",
};
export const t = (lang?: string) => (String(lang || "").toLowerCase().startsWith("en") ? EN : ES);
