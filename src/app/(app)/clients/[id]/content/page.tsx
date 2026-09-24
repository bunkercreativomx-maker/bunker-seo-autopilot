import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/pocketbase/auth";
import { getClient } from "@/lib/pocketbase/clients";
import { listArticles } from "@/lib/pocketbase/content";
import { ArticleTable, StatusSummary, STATUS_GROUPS } from "@/components/content/article-list";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ClientContentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ group?: string }> }) {
  const { id } = await params;
  const { group } = await searchParams;
  const { pb } = await requireUser();
  const client = await getClient(pb, id);
  if (!client) notFound();
  const articles = await listArticles(pb, { client: client.id });
  const g = STATUS_GROUPS.find((x) => x.key === group);
  return (
    <div>
      <PageHeader title={`${client.business_name} — Content`} description="Only this client's content." action={<Link href={`/clients/${client.id}`} className="text-sm text-slate-500 hover:text-slate-700">← Back to client</Link>} />
      <StatusSummary articles={articles} hrefFor={(key) => `/clients/${client.id}/content?group=${key}`} />
      <ArticleTable articles={g ? articles.filter((a) => g.statuses.includes(a.status)) : articles} showClient={false} />
    </div>
  );
}
