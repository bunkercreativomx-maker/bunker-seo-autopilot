import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { bunkerConfig } from "./config";
import { pickPublic, type PublicArticle } from "./types";

/**
 * Local store for the Next.js API publisher mode (sites that keep their own
 * copy of the content). This reference implementation uses a JSON file;
 * production sites should back it with their own database. Rows are never
 * hard-deleted: unpublish flips status.
 */
type Row = PublicArticle & { remote_id: string; article_id: string; status: "published" | "unpublished"; idempotency: string[] };
type Store = { rows: Row[]; nonces: Record<string, number> };

function file() {
  return path.resolve(bunkerConfig().localStoreDir, "bunker-content.json");
}

async function read(): Promise<Store> {
  try { return JSON.parse(await fs.readFile(file(), "utf8")) as Store; } catch { return { rows: [], nonces: {} }; }
}

async function write(store: Store) {
  await fs.mkdir(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store), { mode: 0o600 });
  await fs.rename(tmp, file());
}

let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

export const localNonceStore = {
  seen: (n: string) => serial(async () => { const s = await read(); return Boolean(s.nonces[n] && s.nonces[n] > Date.now()); }),
  remember: (n: string, ttlS: number) => serial(async () => {
    const s = await read();
    const now = Date.now();
    for (const [k, v] of Object.entries(s.nonces)) if (v < now) delete s.nonces[k];
    s.nonces[n] = now + ttlS * 1000;
    await write(s);
  }),
};

export async function localList(): Promise<PublicArticle[]> {
  const s = await read();
  return s.rows.filter((r) => r.status === "published").sort((a, b) => b.published_at.localeCompare(a.published_at)).map((r) => pickPublic(r));
}

export async function localGet(slug: string): Promise<PublicArticle | null> {
  const s = await read();
  const r = s.rows.find((x) => x.slug === slug && x.status === "published");
  return r ? pickPublic(r) : null;
}

export type UpsertResult = { remote_id: string; replay: boolean } | { conflict: true };

export function localUpsert(articleId: string, remoteId: string | undefined, article: PublicArticle, idempotencyKey: string): Promise<UpsertResult> {
  return serial(async () => {
    const s = await read();
    const done = s.rows.find((r) => r.idempotency.includes(idempotencyKey));
    if (done) return { remote_id: done.remote_id, replay: true };
    const bySlug = s.rows.find((r) => r.slug === article.slug && r.status === "published");
    if (bySlug && bySlug.article_id !== articleId) return { conflict: true };
    let row = s.rows.find((r) => (remoteId && r.remote_id === remoteId) || r.article_id === articleId);
    if (row && row.article_id !== articleId) return { conflict: true };
    if (!row) {
      row = { ...pickPublic(article), remote_id: crypto.randomUUID(), article_id: articleId, status: "published", idempotency: [] };
      s.rows.push(row);
    } else Object.assign(row, pickPublic(article), { status: "published" });
    row.idempotency = [...row.idempotency.slice(-20), idempotencyKey];
    await write(s);
    return { remote_id: row.remote_id, replay: false };
  });
}

export function localUnpublish(articleId: string, remoteId: string): Promise<boolean> {
  return serial(async () => {
    const s = await read();
    const row = s.rows.find((r) => r.remote_id === remoteId && r.article_id === articleId);
    if (!row) return false;
    row.status = "unpublished";
    await write(s);
    return true;
  });
}
