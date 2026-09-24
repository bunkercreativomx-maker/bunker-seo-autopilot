import { Fragment } from "react";

// Minimal, safe Markdown → React renderer for previews (no HTML injection:
// everything is rendered as React text nodes; links limited to http(s)/relative).
type Block =
  | { type: "h"; level: number; text: string }
  | { type: "p"; text: string }
  | { type: "ul" | "ol"; items: string[] }
  | { type: "quote"; text: string };

function parse(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: { type: "ul" | "ol"; items: string[] } | null = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "p", text: paragraph.join(" ") });
    paragraph = [];
    if (list) blocks.push(list);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) { flush(); continue; }
    if (heading) { flush(); blocks.push({ type: "h", level: heading[1].length, text: heading[2] }); continue; }
    if (bullet || numbered) {
      if (paragraph.length) { blocks.push({ type: "p", text: paragraph.join(" ") }); paragraph = []; }
      const type = bullet ? "ul" : "ol";
      if (!list || list.type !== type) { if (list) blocks.push(list); list = { type, items: [] }; }
      list.items.push((bullet || numbered)![1]);
      continue;
    }
    if (line.startsWith(">")) { flush(); blocks.push({ type: "quote", text: line.replace(/^>\s?/, "") }); continue; }
    if (list) { blocks.push(list); list = null; }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

function safeHref(href: string): string | null {
  const value = href.trim();
  if (/^https?:\/\//i.test(value) || value.startsWith("/") || value.startsWith("#")) return value;
  return null;
}

function inline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const key = `${keyPrefix}-${i++}`;
    if (match[1] !== undefined) {
      const href = safeHref(match[2]);
      nodes.push(href ? <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-sky-700 underline underline-offset-2">{match[1]}</a> : <Fragment key={key}>{match[1]}</Fragment>);
    } else if (match[3] !== undefined) nodes.push(<strong key={key}>{match[3]}</strong>);
    else if (match[4] !== undefined) nodes.push(<em key={key}>{match[4]}</em>);
    else if (match[5] !== undefined) nodes.push(<code key={key} className="rounded bg-slate-100 px-1 text-[0.9em]">{match[5]}</code>);
    last = pattern.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const HEADING: Record<number, string> = {
  1: "text-3xl font-bold tracking-tight text-slate-900 mt-2 mb-4",
  2: "text-2xl font-semibold text-slate-900 mt-8 mb-3",
  3: "text-xl font-semibold text-slate-900 mt-6 mb-2",
  4: "text-lg font-semibold text-slate-900 mt-4 mb-2",
  5: "font-semibold text-slate-900 mt-4 mb-1",
  6: "font-semibold text-slate-700 mt-4 mb-1",
};

export function Markdown({ source, skipFirstH1 = false }: { source: string; skipFirstH1?: boolean }) {
  const blocks = parse(source || "");
  const firstH1 = skipFirstH1 ? blocks.findIndex((b) => b.type === "h" && b.level === 1) : -1;
  return (
    <div className="text-[15px] leading-7 text-slate-700">
      {blocks.map((block, index) => {
        const key = `b${index}`;
        if (block.type === "h") {
          if (index === firstH1) return null;
          const Tag = `h${Math.min(block.level, 6)}` as "h1";
          return <Tag key={key} className={HEADING[block.level]}>{inline(block.text, key)}</Tag>;
        }
        if (block.type === "p") return <p key={key} className="my-3">{inline(block.text, key)}</p>;
        if (block.type === "quote") return <blockquote key={key} className="my-3 border-l-4 border-slate-200 pl-4 italic">{inline(block.text, key)}</blockquote>;
        const List = block.type === "ul" ? "ul" : "ol";
        return <List key={key} className={`my-3 space-y-1 pl-6 ${block.type === "ul" ? "list-disc" : "list-decimal"}`}>{block.items.map((item, j) => <li key={`${key}-${j}`}>{inline(item, `${key}-${j}`)}</li>)}</List>;
      })}
    </div>
  );
}
