import { requireUser } from "@/lib/pocketbase/auth";
import { getWebsite } from "@/lib/pocketbase/websites";
import { getLatestSnapshot, listPages, listIssues } from "@/lib/pocketbase/analysis";
import { Card, CardHeader, CardBody, EmptyState } from "@/components/ui";
import { AnalyzeButton } from "@/components/analyze-button";
import { PagesTable } from "@/components/pages-table";

export const dynamic = "force-dynamic";

export default async function WebsitePagesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { pb, user } = await requireUser();
  const website = await getWebsite(pb, id);
  if (!website) return null;

  const [snapshot, pages] = await Promise.all([
    getLatestSnapshot(pb, website.id),
    listPages(pb, website.id),
  ]);

  if (!snapshot) {
    return (
      <Card>
        <CardHeader title="Pages" action={<AnalyzeButton websiteId={website.id} hasAnalyzed={false} />} />
        <CardBody>
          <EmptyState
            title="No pages discovered yet"
            description="Run Analyze Website to crawl this site and discover its pages."
          />
        </CardBody>
      </Card>
    );
  }

  // issue counts per page for display
  const issues = await listIssues(pb, website.id, { status: "open" });
  const issuesByPage = new Map<string, number>();
  for (const i of issues) {
    if (i.page) issuesByPage.set(i.page, (issuesByPage.get(i.page) ?? 0) + 1);
  }

  return (
    <Card>
      <CardHeader
        title="Pages"
        subtitle={`${pages.length} page(s) from last crawl`}
        action={user.role !== "viewer" ? <AnalyzeButton websiteId={website.id} hasAnalyzed /> : undefined}
      />
      <CardBody className="px-0">
        {pages.length === 0 ? (
          <EmptyState title="No pages" description="The last crawl discovered no pages." />
        ) : (
          <PagesTable pages={pages} issuesByPage={issuesByPage} websiteId={website.id} />
        )}
      </CardBody>
    </Card>
  );
}