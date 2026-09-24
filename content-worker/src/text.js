// Text utilities: sanitizing untrusted text, HTML → text extraction, markdown
// helpers and similarity metrics used by duplicate / local-differentiation checks.

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function safeText(value, maxLength = 500) {
  if (value == null) return "";
  return String(value).replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function safeMultiline(value, maxLength = 20_000) {
  if (value == null) return "";
  return String(value).replace(CONTROL, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, maxLength);
}

export function normalizeForMatch(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%$.,]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(value) {
  return normalizeForMatch(value).replace(/[.,]/g, " ").split(" ").filter(Boolean);
}

const ENTITY = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", uuml: "ü", iexcl: "¡", iquest: "¿", deg: "°", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”" };
function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return " "; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return " "; } })
    .replace(/&([a-z]+);/gi, (m, name) => ENTITY[name] ?? " ");
}

/** Extract readable main text from HTML. Scripts/styles/nav/footer are dropped. */
export function htmlToText(html, maxLength = 20_000) {
  let s = String(html || "");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|template|svg|iframe|canvas|form|nav|footer)\b[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header)\b[^>]*>/gi, "\n");
  s = s.replace(/<h([1-6])\b[^>]*>/gi, (_, level) => `\n${"#".repeat(Number(level))} `);
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return safeMultiline(s.split("\n").map((line) => line.trim()).filter(Boolean).join("\n"), maxLength);
}

export function extractTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? safeText(decodeEntities(match[1]), 300) : "";
}

/** Plain text from markdown (for similarity / density checks). */
export function markdownToText(markdown) {
  return String(markdown || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_>`|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function wordCount(markdown) {
  return tokens(markdownToText(markdown)).length;
}

export function headingsFromMarkdown(markdown) {
  const out = [];
  for (const line of String(markdown || "").split("\n")) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (match) out.push({ level: match[1].length, text: match[2].trim() });
  }
  return out;
}

export function linksFromMarkdown(markdown) {
  const out = [];
  const re = /(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = re.exec(String(markdown || "")))) out.push({ anchor: match[1].trim(), url: match[2].trim(), index: match.index, raw: match[0] });
  return out;
}

export function shingles(text, size = 5) {
  const words = tokens(text);
  const set = new Set();
  for (let i = 0; i + size <= words.length; i++) set.add(words.slice(i, i + size).join(" "));
  return set;
}

/** Jaccard + containment (share of A's shingles present in B). */
export function similarity(a, b, size = 5) {
  const sa = a instanceof Set ? a : shingles(a, size);
  const sb = b instanceof Set ? b : shingles(b, size);
  if (!sa.size || !sb.size) return { jaccard: 0, containment: 0 };
  let inter = 0;
  for (const item of sa) if (sb.has(item)) inter++;
  return { jaccard: inter / (sa.size + sb.size - inter), containment: inter / sa.size };
}

export function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Crude but dependable language guess between Spanish and English. */
const ES = new Set(["de", "la", "que", "el", "en", "los", "las", "del", "para", "con", "una", "por", "su", "sus", "es", "al", "como", "más", "tu", "sin", "sobre", "también", "puede", "hogar", "nuestro"]);
const EN = new Set(["the", "and", "of", "to", "in", "for", "is", "with", "your", "you", "that", "are", "on", "can", "our", "this", "from", "how", "what", "be", "or", "it", "by", "at", "home"]);
export function detectLanguage(text) {
  let es = 0;
  let en = 0;
  for (const word of tokens(text).slice(0, 4000)) {
    if (ES.has(word)) es++;
    if (EN.has(word)) en++;
  }
  if (es + en < 20) return { language: "und", es, en };
  return { language: es >= en ? "es" : "en", es, en, ratio: Math.max(es, en) / (es + en) };
}

export function languageBase(code) {
  return String(code || "").toLowerCase().split(/[-_]/)[0] || "und";
}
