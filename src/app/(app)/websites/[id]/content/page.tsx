import { notFound } from "next/navigation";
import { requireUser } from "@/lib/pocketbase/auth";
import { getWebsite } from "@/lib/pocketbase/websites";
import { listArticles } from "@/lib/pocketbase/content";
import { ArticleTable, StatusSummary, STATUS_GROUPS } from "@/components/content/article-list";

export const dynamic = "force-dynamic";

export default async function WebsiteContentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ group?: string }> }) {
  const { id } = await params;
  const { group } = await searchParams;
  const { pb } = await requireUser();
  const website = await getWebsite(pb, id);
  if (!website) notFound();
  // Scoped to this website AND its client: never shows other sites' content.
  const articles = await listArticles(pb, { website: website.id, client: website.client });
  const g = STATUS_GROUPS.find((x) => x.key === group);
  return (
    <div className="mt-6">
      <p className="mb-4 text-sm text-slate-500">Drafts for {website.domain}. Generate new content from an approved opportunity or plan item in the Strategy tab. Nothing is published in Phase 4.</p>
      <StatusSummary articles={articles} hrefFor={(key) => `/websites/${website.id}/content?group=${key}`} />
      <ArticleTable articles={g ? articles.filter((a) => g.statuses.includes(a.status)) : articles} showClient={false} showWebsite={false} />
    </div>
  );
}
