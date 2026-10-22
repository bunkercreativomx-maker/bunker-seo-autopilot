import Link from "next/link";
import { requireUser } from "@/lib/pocketbase/auth";
import { listArticles } from "@/lib/pocketbase/content";
import { listClients } from "@/lib/pocketbase/clients";
import { listWebsites } from "@/lib/pocketbase/websites";
import { ArticleTable, StatusSummary, STATUS_GROUPS } from "@/components/content/article-list";
import { Button, Card, CardBody, PageHeader } from "@/components/ui";
import { ARTICLE_STATUS_LABELS, CONTENT_TYPE_LABELS, type ArticleStatus, type ContentTypeKey } from "@/lib/content/types";

export const dynamic = "force-dynamic";

type Search = { client?: string; website?: string; type?: string; status?: string; language?: string; group?: string };
const ID = /^[a-z0-9]{15}$/;

export default async function ContentDashboardPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const { pb } = await requireUser();
  const client = sp.client && ID.test(sp.client) ? sp.client : undefined;
  const website = sp.website && ID.test(sp.website) ? sp.website : undefined;
  const type = sp.type && sp.type in CONTENT_TYPE_LABELS ? sp.type : undefined;
  const status = sp.status && sp.status in ARTICLE_STATUS_LABELS ? sp.status : undefined;
  const language = sp.language && /^[a-z]{2}(-[a-z]{2})?$/i.test(sp.language) ? sp.language : undefined;
  const clients = await listClients(pb);
  const websites = await listWebsites(pb);
  const base = await listArticles(pb, { client, website, content_type: type, language, status: status === "rejected" ? "rejected" : undefined });
  const group = STATUS_GROUPS.find((g) => g.key === sp.group);
  const articles = base.filter((a) => (status ? a.status === status : true) && (group ? group.statuses.includes(a.status) : true));
  const languages = Array.from(new Set(base.map((a) => a.language).filter(Boolean)));
  const hrefFor = (g: string) => {
    const params = new URLSearchParams(Object.entries({ client, website, type, language, group: g }).filter(([, v]) => v) as Array<[string, string]>);
    return `/content?${params.toString()}`;
  };
  const select = "w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm sm:w-auto sm:max-w-[16rem]";

  const filters = (
          <form className="grid grid-cols-2 items-end gap-2 sm:flex sm:flex-wrap sm:gap-3" method="get">
            <select name="client" defaultValue={client ?? ""} className={select}><option value="">All clients</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.business_name}</option>)}</select>
            <select name="website" defaultValue={website ?? ""} className={select}><option value="">All websites</option>{websites.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
            <select name="type" defaultValue={type ?? ""} className={select}><option value="">All types</option>{(Object.keys(CONTENT_TYPE_LABELS) as ContentTypeKey[]).map((k) => <option key={k} value={k}>{CONTENT_TYPE_LABELS[k]}</option>)}</select>
            <select name="status" defaultValue={status ?? ""} className={select}><option value="">All statuses</option>{(Object.keys(ARTICLE_STATUS_LABELS) as ArticleStatus[]).map((k) => <option key={k} value={k}>{ARTICLE_STATUS_LABELS[k]}</option>)}</select>
            <select name="language" defaultValue={language ?? ""} className={select}><option value="">All languages</option>{languages.map((l) => <option key={l} value={l}>{l}</option>)}</select>
            <Button type="submit" variant="secondary">Filter</Button>
            <Link href="/content" className="text-sm text-slate-500 hover:text-slate-700">Reset</Link>
          </form>
  );

  return (
    <div>
      <PageHeader title="Content" description="Evidence-based content. Drafts → QA → human approval → Publish (manual, confirmed, verified)." />
      <StatusSummary articles={base} hrefFor={hrefFor} />
      <details className="group mb-4 sm:hidden">
        <summary className="cursor-pointer list-none rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700">Filters ▾</summary>
        <div className="mt-2 rounded-xl border border-slate-200 bg-white p-3">{filters}</div>
      </details>
      <Card className="mb-4 hidden sm:block">
        <CardBody>
          {filters}
        </CardBody>
      </Card>
      <ArticleTable articles={articles} />
    </div>
  );
}
