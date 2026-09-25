import Link from "next/link";
import { requireUser } from "@/lib/pocketbase/auth";
import { getWebsite } from "@/lib/pocketbase/websites";
import { getLatestJob, getLatestSnapshot, countOpenIssuesBySeverity, deriveHealth } from "@/lib/pocketbase/analysis";
import { Badge, Button } from "@/components/ui";
import { AnalyzeButton } from "@/components/analyze-button";
import { CrawlProgress } from "@/components/crawl-progress";
import { formatDate } from "@/lib/format";
import { archiveWebsiteAction } from "@/app/actions/websites";
import { getPolicy } from "@/lib/pocketbase/autopilot";
import { SiteRow } from "@/components/today/today-cards";
import { StrategyGenerateButton } from "@/components/strategy-generate-button";
import { isAdmin } from "@/lib/pocketbase/auth";
import type { TodaySite } from "@/lib/pocketbase/today";
import { statusTone } from "@/components/ui";

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

  const [latestJob, snapshot, counts, ap] = await Promise.all([
    getLatestJob(pb, website.id),
    getLatestSnapshot(pb, website.id),
    countOpenIssuesBySeverity(pb, website.id),
    getPolicy(pb, website.id),
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

  const stratVersions = await pb.collection("strategy_versions").getList(1, 1, { filter: `website = "${website.id}"`, requestKey: null }).catch(() => null);
  const hasPlan = (stratVersions?.totalItems ?? 0) > 0;
  const pubInfo = website as unknown as { connection_status?: string; publishing_enabled?: boolean; publishing_environment?: string };
  const connected = pubInfo.connection_status === "connected" && Boolean(pubInfo.publishing_enabled);
  const posts = await pb.collection("articles").getList(1, 5, { filter: `website = "${website.id}" && status != "rejected"`, sort: "-updated", fields: "id,title,primary_keyword,status,qa_score", requestKey: null }).catch(() => null);
  const site: TodaySite = {
    id: website.id, name: website.name, domain: website.domain,
    dailyOn: Boolean(ap?.policy.enabled) && ap?.policy.mode === "SUPERVISED" && ap?.policy.schedule === "daily",
    autoPublish: Boolean(ap?.policy.publish_after_human_approval), paused: Boolean(ap?.policy.paused), connected,
    environment: String(pubInfo.publishing_environment ?? ""), nextRunAt: String(ap?.policy.next_run_at ?? ""),
  };
  const steps = [
    { done: hasAnalysis, label: "Read your website", hint: hasAnalysis ? `${snapshot?.total_pages ?? 0} pages found` : "We scan your pages (1–3 min)", action: !hasAnalysis || isRunning ? (isRunning && latestJob ? <CrawlProgress jobId={latestJob.id} /> : <AnalyzeButton websiteId={website.id} hasAnalyzed={hasAnalysis} />) : null },
    { done: hasPlan, label: "Find what to write about", hint: hasPlan ? "Keyword plan ready" : "We pick topics your buyers search for", action: hasAnalysis && !hasPlan ? <StrategyGenerateButton websiteId={website.id} hasStrategy={false} /> : null },
    { done: connected, label: "Connect your website", hint: connected ? `Publishing to ${pubInfo.publishing_environment === "staging" ? "staging" : "your site"}` : "Publish without copy/paste", action: !connected ? <Link href={`/websites/${website.id}/publishing`}><Button variant="secondary">Connect</Button></Link> : null },
  ];
  const ready = steps.every((st) => st.done);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Daily post switch */}
      <div className={`rounded-2xl border p-5 ${site.dailyOn ? "border-emerald-200 bg-emerald-50/50" : "border-slate-200 bg-white"}`}>
        <p className="text-base font-semibold text-slate-900">{site.dailyOn ? "Daily posts are on ✨" : "Daily posts"}</p>
        <p className="mt-0.5 text-sm text-slate-500">
          {site.dailyOn ? "Every morning a new post is written, fact-checked and scored. You approve it in Today." : ready ? "Turn it on and a new post will be ready for you every morning." : "Finish the setup below, then turn it on."}
        </p>
        <div className="mt-2 border-t border-slate-200/70"><SiteRow site={site} canEdit={isAdmin(user.role) && (ready || site.dailyOn)} /></div>
      </div>

      {/* Setup */}
      {!ready && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <p className="text-sm font-semibold text-slate-900">Setup · {steps.filter((st) => st.done).length}/3</p>
          <ol className="mt-3 space-y-3">
            {steps.map((st, i) => (
              <li key={st.label} className="flex items-center gap-3">
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${st.done ? "bg-emerald-500 text-white" : "bg-slate-100 text-slate-500"}`}>{st.done ? "✓" : i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-medium ${st.done ? "text-slate-500" : "text-slate-900"}`}>{st.label}</p>
                  <p className="text-xs text-slate-500">{st.hint}</p>
                </div>
                {st.action}
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Recent posts */}
      <div className="rounded-2xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between px-5 pt-4">
          <p className="text-sm font-semibold text-slate-900">Recent posts</p>
          <Link href={`/websites/${website.id}/content`} className="text-xs font-medium text-sky-700 hover:underline">All posts →</Link>
        </div>
        <div className="divide-y divide-slate-100 px-5 py-2">
          {(posts?.items ?? []).map((a) => (
            <Link key={a.id} href={`/articles/${a.id}`} className="flex items-center gap-3 py-2.5 hover:opacity-80">
              <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{String(a.title || a.primary_keyword || "Untitled")}</span>
              <Badge tone={statusTone(String(a.status))}>{friendly(String(a.status))}</Badge>
            </Link>
          ))}
          {(posts?.items.length ?? 0) === 0 && <p className="py-4 text-center text-sm text-slate-500">No posts yet.</p>}
        </div>
      </div>

      {/* Website health (compact) */}
      {hasAnalysis && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm">
          <span className="font-medium text-slate-900">Website health</span>
          <Badge tone={healthTone(health)}>{health.replace(/_/g, " ")}</Badge>
          <span className="text-xs text-slate-500">{counts.critical + counts.high} important issues · last scan {formatDate(latestJob?.created_at ?? latestJob?.created)}</span>
          <span className="ml-auto flex items-center gap-2">
            <AnalyzeButton websiteId={website.id} hasAnalyzed />
            <Link href={`/websites/${website.id}/seo`} className="text-xs font-medium text-sky-700 hover:underline">Details →</Link>
          </span>
        </div>
      )}

      <details className="rounded-2xl border border-slate-200 bg-white px-5 py-3">
        <summary className="cursor-pointer text-sm font-medium text-slate-600">Website details</summary>
        <div className="mt-3">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            {info.map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
                <dd className="mt-0.5 text-sm text-slate-800 break-all">{value}</dd>
              </div>
            ))}
          </dl>
          <Link href={`/websites/${website.id}/edit`} className="mt-3 inline-block text-xs font-medium text-sky-700 hover:underline">Edit website →</Link>
        </div>
      </details>

      {user.role !== "viewer" && (
        <div className="flex items-center justify-between rounded-2xl border border-rose-100 bg-rose-50/50 px-5 py-3">
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

const FRIENDLY: Record<string, string> = {
  awaiting_approval: "Ready for you", approved: "Approved", published: "Published", publish_queued: "Publishing", publishing: "Publishing",
  needs_revision: "Needs a look", failed: "Failed", publish_failed: "Publish failed", unpublished: "Unpublished", draft: "Writing",
};
function friendly(s: string) { return FRIENDLY[s] ?? (s.includes("ing") || ["queued", "qa", "brief_ready"].includes(s) ? "Writing" : s.replace(/_/g, " ")); }
