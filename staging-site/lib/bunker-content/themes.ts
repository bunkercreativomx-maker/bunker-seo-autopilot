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
  // Optional hero tuning. `heroBg` paints the hero when there is no photo;
  // `heroOverlay` is the gradient laid over `heroImage`; `heroAccent` colors the
  // highlighted word of the title (defaults to colors.accent).
  heroBg?: string;
  heroOverlay?: string;
  heroAccent?: string;
  // Fallback glyph used when a post has no featured image (default ❄).
  icon?: string;
  // Square logos need a smaller footer size; defaults to 250px.
  footLogoWidth?: string;
  // Very wide logos: cap the header logo width (image keeps its aspect ratio).
  logoMaxWidth?: string;
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
const TLALOC = "https://www.tlalocsolfuturo.com";
const BC = "https://bunkercreativomx.com";
const CAM = "https://creditoatumedida.com";
const DP = "https://donpunto.com";
const HUBA = "https://blog.bunkerank.com";

const THEMES: Record<string, HubTheme> = {
  // Empire Refrigeration - weneedair.com
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
    book: { label: "BOOK NOW!", href: "tel:+191****0747" },
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

  // Tlaloc SolFuturo - tlalocsolfuturo.com (paneles solares, Cd. Ju\u00e1rez)
  ckyaxb7yohx5bvc: {
    logo: `${TLALOC}/assets/logo-horizontal.jpeg`,
    logoAlt: "Tlaloc SolFuturo - Paneles Solares en Ciudad Ju\u00e1rez",
    colors: { primary: "#0D6EFD", accent: "#1975BB", hot: "#25D366", bar: "#0B5ED7" },
    nav: [
      { label: "Inicio", href: `${TLALOC}/#inicio` },
      { label: "Servicios", href: `${TLALOC}/#servicios` },
      { label: "Cotizador", href: `${TLALOC}/#cotizador` },
      { label: "FAQ", href: `${TLALOC}/#faq` },
      { label: "Blog", href: `${TLALOC}/blog` },
      { label: "Contacto", href: `${TLALOC}/#contacto` },
    ],
    phoneLabel: "Cotiza gratis: 656 695 3960",
    schedule: { label: "Cotizar en l\u00ednea", href: `${TLALOC}/#cotizador` },
    book: { label: "WhatsApp", href: "https://wa.me/526566953960" },
    heroTitle: ["Gu\u00edas de energ\u00eda solar", "para tu hogar y tu negocio"],
    heroSub: "Ahorro, retorno de inversi\u00f3n y mantenimiento explicados por el equipo de SolFuturo en Ciudad Ju\u00e1rez.",
    heroImage: `${TLALOC}/assets/inst-04.webp`,
    heroBg: "linear-gradient(135deg,#0D6EFD 0%,#1975BB 100%)",
    heroOverlay: "linear-gradient(100deg, rgba(11,94,215,.93) 35%, rgba(25,117,187,.68))",
    heroAccent: "#9DDBFF",
    icon: "\u2600",
    footerBlurb: "Dise\u00f1amos e instalamos sistemas solares para casas y negocios que buscan ahorrar energ\u00eda y reducir sus costos el\u00e9ctricos. Hechos en Cd. Ju\u00e1rez.",
    email: "Soporte@solfuturo.com.mx",
    area: "Ciudad Ju\u00e1rez, Chihuahua",
    facebook: "https://www.facebook.com/Solfuturo",
    quickLinks: [
      { label: "Inicio", href: `${TLALOC}/#inicio` },
      { label: "Servicios", href: `${TLALOC}/#servicios` },
      { label: "Cotizador", href: `${TLALOC}/#cotizador` },
      { label: "FAQ", href: `${TLALOC}/#faq` },
      { label: "Blog", href: `${TLALOC}/blog` },
      { label: "Contacto", href: `${TLALOC}/#contacto` },
    ],
    ctaTitle: "\u00bfListo para bajar tu recibo de luz?",
    ctaText: "Cotiza tu sistema solar con tu recibo de CFE y recibe una propuesta con retorno de inversi\u00f3n claro.",
    author: "Equipo SolFuturo",
    readMore: "Leer m\u00e1s",
  },

  // Bunker Creativo - bunkercreativomx.com (agencia web/redes, Cd. Juárez + El Paso)
  xjkrxrh3l7mpv72: {
    logo: `${BC}/assets/img/logo.png`,
    logoAlt: "Bunker Creativo - Redes sociales y páginas web",
    colors: { primary: "#0d1430", accent: "#ff5b1f", hot: "#c93d0a", bar: "#c8ff2e" },
    nav: [
      { label: "Inicio", href: `${BC}/#top` },
      { label: "Páginas web", href: `${BC}/#web` },
      { label: "Redes", href: `${BC}/#paquetes` },
      { label: "Coroplast", href: `${BC}/#coroplast` },
      { label: "Imprenta", href: `${BC}/#imprenta` },
      { label: "Blog", href: `${BC}/blog` },
      { label: "Contacto", href: `${BC}/#contacto` },
    ],
    phoneLabel: "Cotiza por WhatsApp: 656 682 5587",
    schedule: { label: "Cotizar por WhatsApp", href: "https://wa.me/5216566825587?text=Hola%20Bunker%2C%20quiero%20cotizar" },
    book: { label: "WhatsApp", href: "https://wa.me/5216566825587?text=Hola%20Bunker%2C%20quiero%20cotizar" },
    heroTitle: ["Guías de web y redes", "para tu negocio"],
    heroSub: "Ideas prácticas de páginas web, redes sociales, branding e imprenta para negocios de El Paso, Ciudad Juárez y todo México.",
    heroBg: "linear-gradient(135deg,#0d1430 0%,#18244f 100%)",
    heroAccent: "#c8ff2e",
    icon: "✦",
    footLogoWidth: "110px",
    footerBlurb: "Redes sociales y páginas web para El Paso, Juárez y todo México. Imprenta y coroplast en Cd. Juárez.",
    email: "bunkercreativomx@gmail.com",
    area: "El Paso, Ciudad Juárez y todo México",
    quickLinks: [
      { label: "Inicio", href: `${BC}/#top` },
      { label: "Páginas web", href: `${BC}/#web` },
      { label: "Redes", href: `${BC}/#paquetes` },
      { label: "Coroplast", href: `${BC}/#coroplast` },
      { label: "Imprenta", href: `${BC}/#imprenta` },
      { label: "Blog", href: `${BC}/blog` },
      { label: "Contacto", href: `${BC}/#contacto` },
    ],
    ctaTitle: "¿Quieres que tu negocio se vea premium?",
    ctaText: "Cotiza tu página web, tus redes sociales o tu imprenta por WhatsApp y arrancamos esta semana.",
    author: "Bunker Creativo",
    readMore: "Leer más",
  },
  // Créditos a tu Medida - creditoatumedida.com (crédito vía nómina, jubilados y pensionados, Cd. Juárez)
  n35lrwj1jv35394: {
    logo: `${HUBA}/themes/creditos-wordmark.png`,
    logoAlt: "Créditos a tu medida - Crédito vía nómina para jubilados y pensionados",
    colors: { primary: "#0a1628", accent: "#d4b84a", hot: "#1e3a66", bar: "#c9a227" },
    nav: [
      { label: "Créditos", href: `${CAM}/#creditos` },
      { label: "Proceso", href: `${CAM}/#proceso` },
      { label: "Requisitos", href: `${CAM}/#requisitos` },
      { label: "Ubicación", href: `${CAM}/#ubicacion` },
      { label: "Blog", href: `${CAM}/blog` },
    ],
    phoneLabel: "Llámanos: 656 374 8899",
    schedule: { label: "Escríbenos por WhatsApp", href: "https://wa.me/526563748899" },
    book: { label: "Escríbenos", href: "https://wa.me/526563748899" },
    heroTitle: ["Guías de crédito", "para jubilados y pensionados"],
    heroSub: "Crédito vía nómina explicado claro y sin letras chiquitas, por el equipo de Créditos a tu medida en Ciudad Juárez.",
    heroImage: `${CAM}/fotos/hero-real.webp`,
    heroBg: "linear-gradient(135deg,#060d1c 0%,#16294f 100%)",
    heroOverlay: "linear-gradient(100deg, rgba(6,13,28,.94) 38%, rgba(15,32,56,.72))",
    heroAccent: "#e3cd7f",
    icon: "✦",
    footLogoWidth: "190px",
    footerBlurb: "Promotor de crédito vía nómina para jubilados y pensionados, en alianza con Financiera Fortaleza, S.A. de C.V., SOFOM, E.N.R.",
    area: "Benjamin Franklin 3220, Int 22-D, Zona Pronaf, Ciudad Juárez, Chihuahua",
    quickLinks: [
      { label: "Inicio", href: `${CAM}/` },
      { label: "Créditos", href: `${CAM}/#creditos` },
      { label: "Proceso", href: `${CAM}/#proceso` },
      { label: "Requisitos", href: `${CAM}/#requisitos` },
      { label: "Ubicación", href: `${CAM}/#ubicacion` },
      { label: "Blog", href: `${CAM}/blog` },
    ],
    ctaTitle: "¿Quieres saber cuánto te pueden prestar?",
    ctaText: "Cada caso es distinto. Escríbenos por WhatsApp o llámanos al 656 374 8899 y un asesor revisa tu caso sin compromiso.",
    author: "Equipo Créditos a tu medida",
    readMore: "Leer más",
  },

  // Don Punto - donpunto.com (punto de venta para restaurantes en México)
  "86ix1a1thvb52ew": {
    logo: `${DP}/brand/logo-3d-compact.webp`,
    logoAlt: "Don Punto - Punto de venta para restaurantes",
    logoMaxWidth: "300px",
    colors: { primary: "#0D100E", accent: "#16895F", hot: "#0E6F4D", bar: "#F5B323" },
    nav: [
      { label: "Inicio", href: `${DP}/` },
      { label: "Cómo funciona", href: `${DP}/#como-funciona` },
      { label: "Precios", href: `${DP}/#precios` },
      { label: "Preguntas", href: `${DP}/#preguntas` },
      { label: "Blog", href: `${DP}/blog` },
    ],
    phoneLabel: "Punto de venta para restaurantes en México",
    schedule: { label: "Entrar", href: `${DP}/login` },
    book: { label: "Crear cuenta", href: `${DP}/login` },
    heroTitle: ["Guías para vender más", "en tu restaurante"],
    heroSub: "Corte de caja, IVA, inventario y precios en Uber Eats, DiDi Food y Rappi, explicados por el equipo de Don Punto.",
    heroBg: "linear-gradient(135deg,#0D100E 0%,#093A2C 100%)",
    heroAccent: "#F5B323",
    icon: "●",
    footLogoWidth: "220px",
    footerBlurb: "Punto de venta para restaurantes y negocios de comida. Funciona en el celular, la tablet o la compu que ya tienes.",
    email: "soporte@donpunto.com",
    area: "Todo México",
    quickLinks: [
      { label: "Inicio", href: `${DP}/` },
      { label: "Precios", href: `${DP}/#precios` },
      { label: "Blog", href: `${DP}/blog` },
      { label: "Aviso de Privacidad", href: `${DP}/privacidad` },
      { label: "Términos", href: `${DP}/terminos` },
    ],
    ctaTitle: "¿Listo para cuadrar tu caja sin batallar?",
    ctaText: "Crea tu cuenta de Don Punto y empieza a cobrar desde el celular, la tablet o la compu que ya tienes.",
    author: "Equipo Don Punto",
    readMore: "Leer más",
  },
};

export const themeFor = (siteId: string): HubTheme | null => THEMES[siteId] ?? null;
