// UI strings for the client blog shell, in the website's own language.
const ES = {
  staging: "Vista de prueba (staging) — no aparece en Google.",
  website: "Sitio web", call: "Llamar", heroSub: (n: string) => `Guías y respuestas claras de ${n}.`,
  empty: "Pronto publicaremos nuestros primeros artículos.",
  desc: (n: string, a: string) => `Artículos y guías de ${n}${a ? ` en ${a}` : ""}.`,
  updated: "Actualizado", boxText: "¿Tienes dudas sobre este tema? Con gusto te ayudamos.", visit: "Visitar el sitio",
  locale: "es-MX",
};
const EN: typeof ES = {
  staging: "Preview (staging) — not shown on Google.",
  website: "Website", call: "Call", heroSub: (n: string) => `Clear guides and answers from ${n}.`,
  empty: "Our first articles are coming soon.",
  desc: (n: string, a: string) => `Articles and guides from ${n}${a ? ` in ${a}` : ""}.`,
  updated: "Updated", boxText: "Questions about this topic? We're happy to help.", visit: "Visit the website",
  locale: "en-US",
};
export const t = (lang?: string) => (String(lang || "").toLowerCase().startsWith("en") ? EN : ES);
