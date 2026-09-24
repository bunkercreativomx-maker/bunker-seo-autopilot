import { Fragment, type ReactNode } from "react";

// Safe Markdown → React. Raw HTML is never interpreted (React text nodes),
// links are limited to http(s)/relative/#, no event handlers, no embeds.
type Block = { type: "h"; level: number; text: string } | { type: "p"; text: string } | { type: "ul" | "ol"; items: string[] } | { type: "quote"; text: string };

function parse(md: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { type: "ul" | "ol"; items: string[] } | null = null;
  const flush = () => {
    if (para.length) blocks.push({ type: "p", text: para.join(" ") });
    para = [];
    if (list) blocks.push(list);
    list = null;
  };
  for (const raw of md.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const b = /^\s*[-*+]\s+(.*)$/.exec(line);
    const n = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) { flush(); continue; }
    if (h) { flush(); blocks.push({ type: "h", level: h[1].length, text: h[2] }); continue; }
    if (b || n) {
      if (para.length) { blocks.push({ type: "p", text: para.join(" ") }); para = []; }
      const type = b ? "ul" : "ol";
      if (!list || list.type !== type) { if (list) blocks.push(list); list = { type, items: [] }; }
      list.items.push((b || n)![1]);
      continue;
    }
    if (line.startsWith(">")) { flush(); blocks.push({ type: "quote", text: line.replace(/^>\s?/, "") }); continue; }
    if (list) { blocks.push(list); list = null; }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

export function safeHref(href: string): string | null {
  const v = href.trim();
  if (/^https?:\/\//i.test(v) || (v.startsWith("/") && !v.startsWith("//")) || v.startsWith("#")) return v;
  return null;
}

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1] !== undefined) {
      const href = safeHref(m[2]);
      out.push(href ? <a key={k} href={href} rel={/^https?:/i.test(href) ? "noopener noreferrer" : undefined}>{m[1]}</a> : <Fragment key={k}>{m[1]}</Fragment>);
    } else if (m[3] !== undefined) out.push(<strong key={k}>{m[3]}</strong>);
    else if (m[4] !== undefined) out.push(<em key={k}>{m[4]}</em>);
    else if (m[5] !== undefined) out.push(<code key={k}>{m[5]}</code>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source, skipFirstH1 = true }: { source: string; skipFirstH1?: boolean }) {
  let skipped = !skipFirstH1;
  return (
    <>
      {parse(source).map((b, i) => {
        const k = `b${i}`;
        if (b.type === "h") {
          if (b.level === 1 && !skipped) { skipped = true; return null; }
          const Tag = `h${Math.max(2, b.level)}` as "h2";
          return <Tag key={k}>{inline(b.text, k)}</Tag>;
        }
        if (b.type === "p") return <p key={k}>{inline(b.text, k)}</p>;
        if (b.type === "quote") return <blockquote key={k}>{inline(b.text, k)}</blockquote>;
        const L = b.type;
        return <L key={k}>{b.items.map((it, j) => <li key={`${k}-${j}`}>{inline(it, `${k}-${j}`)}</li>)}</L>;
      })}
    </>
  );
}
