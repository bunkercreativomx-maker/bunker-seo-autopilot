import Link from "next/link";
import { requireUser } from "@/lib/pocketbase/auth";
import { getWebsite } from "@/lib/pocketbase/websites";
import { getPage, listIssues, listPageLinks, listLinkedPages } from "@/lib/pocketbase/analysis";
import { Card, CardHeader, CardBody, Badge } from "@/components/ui";

export const dynamic = "force-dynamic";

function tone(s: string): "slate" | "green" | "amber" | "red" | "blue" {
  switch (s) {
    case "Indexable": return "green";
    case "Noindex": return "red";
    case "Blocked": case "Redirect": case "Error": return "amber";
    default: return "slate";
  }
}

export default async function PageDetailPage({ params }: { params: Promise<{ id: string; pageId: string }> }) {
  const { id, pageId } = await params;
  const { pb } = await requireUser();
  const website = await getWebsite(pb, id);
  const page = await getPage(pb, pageId);
  if (!website || !page) return null;

  const [issues, outLinks, inLinks] = await Promise.all([
    listIssues(pb, website.id, { page: pageId, status: "all" }),
    listPageLinks(pb, pageId),
    listLinkedPages(pb, pageId),
  ]);

  const detail: Array<[string, React.ReactNode]> = [
    ["URL", <span key="u" className="break-all">{page.url}</span>],
    ["HTTP Status", page.status_code ?? "—"],
    ["Content Type", page.content_type || "—"],
    ["Indexability", page.indexable === undefined ? "—" : (
      <span className="inline-flex items-center gap-2">
        {page.indexable ? "Indexable" : "Non-indexable"}
        {page.indexability_reason && <Badge tone={tone(page.indexability_reason)}>{page.indexability_reason}</Badge>}
      </span>
    )],
    ["Canonical", page.canonical_url || "—"],
    ["Language", page.language || "—"],
    ["Word Count", page.word_count ?? "—"],
    ["Internal Links", page.internal_links_count ?? "—"],
    ["External Links", page.external_links_count ?? "—"],
    ["Images", `${page.images_count ?? 0} (${page.images_missing_alt ?? 0} missing alt)`],
    ["Content Hash", page.content_hash ? <code className="font-mono text-xs">{page.content_hash}</code> : "—"],
    ["Path", page.path || "—"],
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href={`/websites/${website.id}/pages`} className="text-sm font-medium text-sky-600 hover:text-sky-500">← Back to pages</Link>
          <h1 className="mt-2 text-xl font-semibold text-slate-900">{page.title || "Untitled page"}</h1>
          <p className="mt-1 truncate text-sm text-slate-500">{page.url}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Page Info" />
          <CardBody>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
              {detail.map(([label, value]) => (
                <div key={label} className={label === "URL" ? "sm:col-span-2" : ""}>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
                  <dd className="mt-0.5 text-sm text-slate-800">{value}</dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Issues" subtitle={`${issues.length} total`} />
          <CardBody className="space-y-2">
            {issues.length === 0 ? (
              <p className="text-sm text-slate-500">No issues for this page.</p>
            ) : (
              issues.map((i) => (
                <div key={i.id} className="rounded-lg border border-slate-200 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Badge tone={i.severity === "critical" ? "red" : i.severity === "high" || i.severity === "medium" ? "amber" : i.severity === "opportunity" ? "blue" : "slate"}>
                      {i.severity}
                    </Badge>
                    <span className="text-sm font-medium text-slate-900">{i.title || i.issue_type}</span>
                  </div>
                  {i.recommended_action && <p className="mt-1 text-xs text-slate-600">{i.recommended_action}</p>}
                </div>
              ))
            )}
          </CardBody>
        </Card>
      </div>

      {/* schema / headings / links */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader title="Schema Types" />
          <CardBody>
            {page.schema_types && page.schema_types.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {page.schema_types.map((t) => <Badge key={t} tone="blue">{t}</Badge>)}
              </div>
            ) : (
              <p className="text-sm text-slate-500">None detected.</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Headings (H1/H2/H3)" />
          <CardBody className="space-y-2">
            {(page.headings?.h1 || []).map((h, i) => <div key={`h1-${i}`}><Badge tone="slate">H1</Badge> <span className="text-sm text-slate-800">{h}</span></div>)}
            {(page.headings?.h2 || []).slice(0, 10).map((h, i) => <div key={`h2-${i}`}><Badge tone="slate">H2</Badge> <span className="text-sm text-slate-800">{h}</span></div>)}
            {(page.headings?.h3 || []).slice(0, 10).map((h, i) => <div key={`h3-${i}`}><Badge tone="slate">H3</Badge> <span className="text-sm text-slate-800">{h}</span></div>)}
            {!page.headings?.h1?.length && !page.headings?.h2?.length && !page.headings?.h3?.length && (
              <p className="text-sm text-slate-500">No headings detected.</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Internal Link Graph" subtitle={`${outLinks.length} out · ${inLinks.length} in`} />
          <CardBody className="space-y-1 text-sm">
            {outLinks.slice(0, 12).map((l) => (
              <div key={l.id} className="truncate text-slate-700">
                <span className="text-sky-600">→</span> {pretty(l.destination_url)}
              </div>
            ))}
            {outLinks.length === 0 && <p className="text-slate-500">No outgoing internal links recorded.</p>}
            {inLinks.length > 0 && (
              <div className="pt-2 text-xs text-slate-500">
                Linked from {inLinks.length} page(s).
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function pretty(u: string): string {
  try {
    const url = new URL(u);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return u;
  }
}