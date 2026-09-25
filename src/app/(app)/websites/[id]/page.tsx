import Link from "next/link";
import { requireUser } from "@/lib/pocketbase/auth";
import { getWebsite } from "@/lib/pocketbase/websites";
import { getLatestJob, getLatestSnapshot, countOpenIssuesBySeverity, deriveHealth } from "@/lib/pocketbase/analysis";
import { Card, CardHeader, CardBody, Badge, Button } from "@/components/ui";
import { AnalyzeButton } from "@/components/analyze-button";
import { CrawlProgress } from "@/components/crawl-progress";
import { formatDate } from "@/lib/format";
import { archiveWebsiteAction } from "@/app/actions/websites";
import { getPolicy, listActions, listRuns } from "@/lib/pocketbase/autopilot";
import { ModeBadge } from "@/components/autopilot/autopilot-view";

export const dynamic = "force-dynamic";

function healthTone(h: string): "slate" | "green" | "amber" | "red" | "blue" {
  switch (h) {
    case "healthy": return "green";
    case "needs_attention": return "amber";
    case "critical": return "red";
    default: return "slate";
  }
}

export default async function WebsiteOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { pb, user } = await requireUser();
  const website = await getWebsite(pb, id);
  if (!website) return null; // layout handles notFound

  const [latestJob, snapshot, counts, ap, apRuns, apWaiting] = await Promise.all([
    getLatestJob(pb, website.id),
    getLatestSnapshot(pb, website.id),
    countOpenIssuesBySeverity(pb, website.id),
    getPolicy(pb, website.id),
    listRuns(pb, `website = "${website.id}" && dry_run = false`, 1),
    listActions(pb, `website = "${website.id}" && status = "waiting_for_approval"`, 20),
  ]);

  const client = website.expand?.client;
  const hasAnalysis = !!snapshot;
  const health = deriveHealth(counts, hasAnalysis);
  const isRunning = latestJob && (latestJob.status === "queued" || latestJob.status === "running");

  const info: Array<[string, string]> = [
    ["Client", client?.business_name ?? "—"],
    ["Domain", website.domain],
    ["Platform", website.platform],
    ["Primary Language", website.primary_language ?? "—"],
    ["Country", website.country ?? "—"],
    ["Target Locations", website.target_locations ?? "—"],
    ["Sitemap", website.sitemap_url || "—"],
    ["Robots", website.robots_url || "—"],
    ["Added", formatDate(website.created_at ?? website.created)],
  ];

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      {/* Left: crawl + health */}
      <Card className="lg:col-span-2">
        <CardHeader
          title="Analysis"
          subtitle={latestJob ? `Last crawl: ${formatDate(latestJob.created_at ?? latestJob.created)}` : "Not analyzed yet"}
          action={
            <div className="flex items-center gap-2">
              <Link href={`/websites/${website.id}/edit`}>
                <Button variant="secondary">Edit Website</Button>
              </Link>
              <AnalyzeButton websiteId={website.id} hasAnalyzed={hasAnalysis} />
            </div>
          }
        />
        <CardBody className="space-y-4">
          {isRunning && latestJob ? (
            <CrawlProgress jobId={latestJob.id} />
          ) : hasAnalysis ? (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
              <Stat label="Pages" value={snapshot?.total_pages ?? 0} />
              <Stat label="Indexable" value={snapshot?.indexable_pages ?? 0} />
              <Stat label="Critical" value={snapshot?.critical_issues ?? 0} />
              <Stat label="High" value={snapshot?.high_issues ?? 0} />
              <Stat label="Medium" value={snapshot?.medium_issues ?? 0} />
              <Stat label="Low" value={snapshot?.low_issues ?? 0} />
              <Stat label="Opportunities" value={snapshot?.opportunities ?? 0} />
              <Stat label="Total Issues" value={(snapshot?.total_issues ?? 0) || counts.total} />
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center text-sm text-slate-500">
              This website has not been analyzed yet. Press <strong>Analyze Website</strong> to crawl it,
              discover pages, extract SEO data, and detect issues.
            </div>
          )}

          {latestJob?.status === "failed" && latestJob.error_message && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-700">
              Last crawl failed: <code className="font-mono">{latestJob.error_message}</code>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Right: details */}
      <Card>
        <CardHeader title="Website Health" action={<Badge tone={healthTone(health)}>{health.replace(/_/g, " ")}</Badge>} />
        <CardBody className="space-y-3">
          {hasAnalysis ? (
            <>
              <div className="mb-2 space-y-1 text-xs text-slate-600">
                <div>Open issues by severity (operational summary, not a ranking score):</div>
              </div>
              <IssueRow label="Critical" value={counts.critical} tone="red" />
              <IssueRow label="High" value={counts.high} tone="amber" />
              <IssueRow label="Medium" value={counts.medium} tone="amber" />
              <IssueRow label="Low" value={counts.low} tone="slate" />
              <IssueRow label="Opportunities" value={counts.opportunity} tone="blue" />
              <Link href={`/websites/${website.id}/seo`} className="mt-3 inline-block text-sm font-medium text-sky-600 hover:text-sky-500">
                View SEO issues →
              </Link>
            </>
          ) : (
            <p className="text-sm text-slate-500">Run an analysis to see the website health summary.</p>
          )}
        </CardBody>
      </Card>

      {/* Autopilot (Phase 7) */}
      <Card className="lg:col-span-3">
        <CardHeader
          title="Autopilot"
          subtitle="Coordinates existing modules. Never approves content or publishes without a recorded human approval."
          action={ap ? <ModeBadge mode={ap.policy.mode} enabled={ap.policy.enabled} paused={ap.policy.paused} orgPaused={ap.organization_paused} /> : <Badge>OFF</Badge>}
        />
        <CardBody>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Last run" value={apRuns[0] ? `${formatDate(apRuns[0].started_at || apRuns[0].created_at)} · ${apRuns[0].status}` : "Never"} />
            <Stat label="Next run" value={ap?.policy.enabled && !ap.policy.paused && ap.policy.next_run_at ? formatDate(ap.policy.next_run_at) : ap?.policy.schedule === "manual_only" ? "Manual only" : "—"} />
            <Stat label="Waiting approval" value={apWaiting.length} />
            <Stat label="Actions (last run)" value={apRuns[0]?.action_count ?? 0} />
          </div>
          <Link href={`/websites/${website.id}/autopilot`} className="mt-3 inline-block text-sm font-medium text-sky-600 hover:text-sky-500">Open Autopilot →</Link>
        </CardBody>
      </Card>

      {/* Full info */}
      <Card className="lg:col-span-3">
        <CardHeader title="Website Information" />
        <CardBody>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            {info.map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
                <dd className="mt-0.5 text-sm text-slate-800 break-all">{value}</dd>
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>

      {user.role !== "viewer" && (
        <div className="lg:col-span-3 flex items-center justify-between rounded-xl border border-rose-200 bg-rose-50 px-5 py-4">
          <div>
            <div className="text-sm font-medium text-rose-800">Archive this website</div>
            <div className="text-xs text-rose-600">Archived websites are hidden from active lists but kept for reference.</div>
          </div>
          <form action={archiveWebsiteAction}>
            <input type="hidden" name="id" value={website.id} />
            <Button variant="danger" type="submit">Archive</Button>
          </form>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
      <div className={typeof value === "number" ? "text-xl font-semibold text-slate-900" : "text-sm font-semibold text-slate-900"}>{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
    </div>
  );
}

function IssueRow({ label, value, tone }: { label: string; value: number; tone: "red" | "amber" | "slate" | "blue" }) {
  const color = { red: "text-rose-600", amber: "text-amber-600", slate: "text-slate-600", blue: "text-sky-600" }[tone];
  return (
    <div className="flex items-center justify-between border-b border-slate-100 pb-2 text-sm">
      <span className="text-slate-600">{label}</span>
      <span className={`font-semibold ${color}`}>{value}</span>
    </div>
  );
}