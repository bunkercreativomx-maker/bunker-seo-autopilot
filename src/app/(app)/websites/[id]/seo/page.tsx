import { requireUser } from "@/lib/pocketbase/auth";
import { getWebsite } from "@/lib/pocketbase/websites";
import { getLatestSnapshot, listIssues } from "@/lib/pocketbase/analysis";
import { Card, CardHeader, CardBody, EmptyState } from "@/components/ui";
import { AnalyzeButton } from "@/components/analyze-button";
import { IssuesTable } from "@/components/issues-table";
import { ISSUE_SEVERITIES } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function WebsiteSeoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ severity?: string; category?: string; status?: string; q?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { pb, user } = await requireUser();
  const website = await getWebsite(pb, id);
  if (!website) return null;

  // PocketBase auto-cancels identical concurrent SDK requests. Fetch the open
  // issue set once, then only make a second (sequential) request when filters
  // require a different result set.
  const [snapshot, openIssues] = await Promise.all([
    getLatestSnapshot(pb, website.id),
    listIssues(pb, website.id, { status: "open" }),
  ]);
  const hasCustomFilters = Boolean(
    sp.severity || sp.category || sp.q || (sp.status && sp.status !== "open")
  );
  const issues = hasCustomFilters
    ? await listIssues(pb, website.id, {
        severity: sp.severity,
        category: sp.category,
        status: sp.status ?? "open",
        q: sp.q,
      })
    : openIssues;
  const counts = { critical: 0, high: 0, medium: 0, low: 0, opportunity: 0, total: 0 };
  for (const issue of openIssues) {
    if (issue.severity in counts) counts[issue.severity]++;
    counts.total++;
  }

  if (!snapshot) {
    return (
      <Card>
        <CardHeader title="SEO Analysis" action={<AnalyzeButton websiteId={website.id} hasAnalyzed={false} />} />
        <CardBody>
          <EmptyState
            title="No SEO analysis yet"
            description="Run Analyze Website to crawl this site, discover pages and detect SEO issues."
          />
        </CardBody>
      </Card>
    );
  }

  const categories = [...new Set(issues.map((i) => i.category).filter(Boolean))];

  return (
    <div className="space-y-5">
      {/* summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
        <SummaryCard label="Total" value={counts.total} tone="slate" />
        <SummaryCard label="Critical" value={counts.critical} tone="red" />
        <SummaryCard label="High" value={counts.high} tone="amber" />
        <SummaryCard label="Medium" value={counts.medium} tone="amber" />
        <SummaryCard label="Low" value={counts.low} tone="slate" />
        <SummaryCard label="Opportunities" value={counts.opportunity} tone="blue" />
      </div>

      {/* filters */}
      <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Severity
          <select name="severity" className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
            <option value="">All</option>
            {ISSUE_SEVERITIES.map((s) => (
              <option key={s} value={s} selected={sp.severity === s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Category
          <select name="category" className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
            <option value="">All</option>
            {categories.map((c) => (
              <option key={c} value={c} selected={sp.category === c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Status
          <select name="status" className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
            <option value="open" selected={!sp.status || sp.status === "open"}>Open</option>
            <option value="all" selected={sp.status === "all"}>All</option>
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-slate-600">
          Search
          <input name="q" defaultValue={sp.q} placeholder="Search issues…" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>
        <button type="submit" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
          Filter
        </button>
      </form>

      {issues.length === 0 ? (
        <Card>
          <CardBody>
            <p className="py-8 text-center text-sm text-slate-500">No issues match these filters.</p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="Issues"
            subtitle={`${issues.filter((i) => i.status === "open").length} open issue(s) shown`}
            action={user.role !== "viewer" ? <AnalyzeButton websiteId={website.id} hasAnalyzed /> : undefined}
          />
          <CardBody className="px-0">
            <IssuesTable issues={issues} websiteId={website.id} />
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone: "slate" | "red" | "amber" | "blue" }) {
  const color = { slate: "text-slate-900", red: "text-rose-600", amber: "text-amber-600", blue: "text-sky-600" }[tone];
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
      <div className={`text-xl font-semibold ${color}`}>{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
    </div>
  );
}