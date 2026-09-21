const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const SPACE = /\s+/g;
const SEPARATORS = /[|–—:]+/g;

export function safeText(value, maxLength = 500) {
  if (value == null) return "";
  return String(value).replace(CONTROL, " ").replace(SPACE, " ").trim().slice(0, maxLength);
}

export function normalizeKeyword(value) {
  return safeText(value)
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(SPACE, " ")
    .trim();
}

export function keywordKey(value) {
  return normalizeKeyword(value)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, "-") || "empty";
}

export function splitBusinessValues(value) {
  const values = Array.isArray(value) ? value : String(value ?? "").replace(CONTROL, " ").split(/[\n,;]+/);
  const unique = new Map();
  for (const item of values.map((entry) => safeText(entry, 120)).filter(Boolean)) {
    const key = normalizeKeyword(item);
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

export function pagePhrases(page, brand = "") {
  const candidates = [page?.h1, page?.title];
  try {
    const path = new URL(page?.url || page?.normalized_url).pathname;
    const segment = decodeURIComponent(path).split("/").filter(Boolean).at(-1);
    if (segment && !/^\d+$/.test(segment)) candidates.push(segment.replace(/[-_]+/g, " "));
  } catch {
    if (page?.path && page.path !== "/") candidates.push(String(page.path).split("/").filter(Boolean).at(-1)?.replace(/[-_]+/g, " "));
  }
  const normalizedBrand = normalizeKeyword(brand);
  const output = [];
  for (const raw of candidates) {
    for (const part of safeText(raw, 300).split(SEPARATORS)) {
      const phrase = safeText(part, 100);
      const normalized = normalizeKeyword(phrase);
      if (normalized.length < 3 || normalized === normalizedBrand || normalized.split(" ").length > 10) continue;
      output.push(phrase);
    }
  }
  return [...new Map(output.map((item) => [normalizeKeyword(item), item])).values()];
}

export function tokenize(value) {
  return new Set(normalizeKeyword(value).split(" ").filter((token) => token.length > 1));
}

export function overlapScore(a, b) {
  const left = tokenize(a);
  const right = tokenize(b);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  // Query coverage: a focused keyword can map to a longer page title/body.
  return intersection / left.size;
}
