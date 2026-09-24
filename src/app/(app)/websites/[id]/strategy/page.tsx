import { requireUser, canWrite } from "@/lib/pocketbase/auth";
import { getWebsite } from "@/lib/pocketbase/websites";
import { getClient } from "@/lib/pocketbase/clients";
import { getLatestSnapshot } from "@/lib/pocketbase/analysis";
import { getStrategyData } from "@/lib/pocketbase/strategy";
import { contentLinksForWebsite } from "@/lib/pocketbase/content";
import { BusinessContextForm } from "@/components/business-context-form";
import { StrategyDashboard } from "@/components/strategy-dashboard";
import { StrategyGenerateButton } from "@/components/strategy-generate-button";
import { StrategyProgress } from "@/components/strategy-progress";
import { Card, CardBody, CardHeader, EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function WebsiteStrategyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { pb, user } = await requireUser();
  const website = await getWebsite(pb, id);
  if (!website) return null;

  // Keep PocketBase reads sequential on this shared SDK client. The SDK cancels
  // duplicate concurrent requests, and strategy helpers already serialize lists.
  const client = website.expand?.client ?? await getClient(pb, website.client);
  const snapshot = await getLatestSnapshot(pb, website.id);
  const strategy = await getStrategyData(pb, website.id);
  const content = await contentLinksForWebsite(pb, website.id);
  if (!client) return null;

  const editable = canWrite(user.role);
  const activeJob = strategy.latestJob && ["queued", "running"].includes(strategy.latestJob.status)
    ? strategy.latestJob
    : null;
  const hasStrategy = strategy.keywords.length > 0 || strategy.clusters.length > 0 || strategy.opportunities.length > 0 || strategy.plan.length > 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="SEO Strategy"
          subtitle="Turn crawl intelligence and business context into a reviewed keyword and content roadmap."
          action={editable ? <StrategyGenerateButton websiteId={website.id} hasStrategy={hasStrategy} disabled={!snapshot || Boolean(activeJob)} /> : undefined}
        />
        <CardBody className="space-y-4">
          {!snapshot && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Analyze this website first. Strategy generation requires current crawl data and will not invent keywords or metrics.
            </div>
          )}
          {activeJob && <StrategyProgress jobId={activeJob.id} />}
          {strategy.latestJob?.status === "failed" && strategy.latestJob.error && !activeJob && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              Last strategy job failed: {strategy.latestJob.error}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <span id="business-context" />
        <CardHeader title="Business Context"  subtitle={`Shared client profile for ${client.business_name}. Changes here also update the client record.`} />
        <CardBody><BusinessContextForm websiteId={website.id} client={client} canEdit={editable} /></CardBody>
      </Card>

      {!hasStrategy && !activeJob ? (
        <EmptyState
          title="No SEO strategy yet"
          description={snapshot ? "Review the business context, then generate a strategy from real crawl and research data." : "Run a website analysis before generating a strategy."}
        />
      ) : (
        <StrategyDashboard websiteId={website.id} data={strategy} canEdit={editable} content={content} />
      )}
    </div>
  );
}
