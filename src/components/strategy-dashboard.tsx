import Link from "next/link";
import { updateStrategyRecordAction } from "@/app/actions/strategy";
import { Badge, Button, Card, CardBody, CardHeader } from "@/components/ui";
import { intentLabel, opportunityLabel, pageTypeLabel } from "@/lib/types";
import type {
  CannibalizationIssue,
  ContentOpportunity,
  InternalLinkOpportunity,
  StrategyData,
  StrategyKeyword,
  StrategyPlanItem,
  TopicCluster,
} from "@/lib/types";

const INTENTS = ["informational", "navigational", "commercial", "transactional", "local", "mixed"];
const PRIORITIES = ["critical", "high", "medium", "low"];
const OPPORTUNITY_ACTIONS = ["create", "optimize", "expand", "merge", "internal_link", "location", "service", "refresh", "ignore"];

type CollectionKey = "keywords" | "clusters" | "opportunities" | "cannibalization" | "internalLinks" | "plan";

function metric(value: number | null | undefined, suffix = ""): string {
  return value === null || value === undefined ? "Not available" : `${value.toLocaleString()}${suffix}`;
}

function display(value: string | null | undefined): string {
  return value?.trim() || "Not available";
}

function tone(value?: string): "slate" | "green" | "amber" | "red" | "blue" {
  if (value === "approved" || value === "completed") return "green";
  if (value === "critical" || value === "ignored" || value === "failed") return "red";
  if (value === "high" || value === "pending") return "amber";
  if (value === "informational" || value === "commercial") return "blue";
  return "slate";
}

function HiddenRecord({ websiteId, recordId, collection }: { websiteId: string; recordId: string; collection: CollectionKey }) {
  return (
    <>
      <input type="hidden" name="websiteId" value={websiteId} />
      <input type="hidden" name="recordId" value={recordId} />
      <input type="hidden" name="collection" value={collection} />
    </>
  );
}

function DecisionButtons({ websiteId, recordId, collection, status, canEdit }: {
  websiteId: string;
  recordId: string;
  collection: CollectionKey;
  status?: string;
  canEdit: boolean;
}) {
  if (!canEdit) return status ? <Badge tone={tone(status)}>{status}</Badge> : null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Badge tone={tone(status)}>{status || "pending"}</Badge>
      <form action={updateStrategyRecordAction}>
        <HiddenRecord websiteId={websiteId} recordId={recordId} collection={collection} />
        <input type="hidden" name="operation" value="approve" />
        <button className="rounded px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50" type="submit">Approve</button>
      </form>
      <form action={updateStrategyRecordAction}>
        <HiddenRecord websiteId={websiteId} recordId={recordId} collection={collection} />
        <input type="hidden" name="operation" value="ignore" />
        <button className="rounded px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50" type="submit">Ignore</button>
      </form>
    </div>
  );
}

function ChangeSelect({ websiteId, recordId, collection, operation, value, values, canEdit }: {
  websiteId: string;
  recordId: string;
  collection: CollectionKey;
  operation: "change_intent" | "change_cluster" | "change_priority" | "change_action";
  value?: string;
  values: Array<{ value: string; label: string }>;
  canEdit: boolean;
}) {
  if (!canEdit) return <span>{display(values.find((option) => option.value === value)?.label || value)}</span>;
  return (
    <form action={updateStrategyRecordAction} className="flex min-w-36 items-center gap-1">
      <HiddenRecord websiteId={websiteId} recordId={recordId} collection={collection} />
      <input type="hidden" name="operation" value={operation} />
      <select name="value" defaultValue={value || ""} className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs">
        {operation === "change_cluster" && <option value="">Unassigned</option>}
        {values.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <button type="submit" className="rounded px-2 py-1 text-xs font-medium text-sky-700 hover:bg-sky-50">Save</button>
    </form>
  );
}

function EmptyRows({ columns, children }: { columns: number; children: string }) {
  return <tr><td colSpan={columns} className="px-4 py-8 text-center text-sm text-slate-500">{children}</td></tr>;
}

const tableClass = "w-full min-w-[760px] text-left text-sm";
const thClass = "bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500";
const tdClass = "border-t border-slate-100 px-4 py-3 align-top text-slate-700";

export function StrategyDashboard({ websiteId, data, canEdit, content = { byKey: {}, byOpportunity: {} } }: { websiteId: string; data: StrategyData; canEdit: boolean; content?: ContentLinks }) {
  const clusterOptions = data.clusters.map((cluster) => ({ value: cluster.id, label: cluster.name }));
  const intentOptions = INTENTS.map((value) => ({ value, label: intentLabel(value) }));
  const priorityOptions = PRIORITIES.map((value) => ({ value, label: value }));

  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-2 text-xs font-medium text-slate-600">
        {["Overview", "Keywords", "Clusters", "Opportunities", "Cannibalization", "Internal Linking", "30/60/90 Plan"].map((label) => (
          <a key={label} href={`#${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`} className="rounded-full bg-slate-100 px-3 py-1.5 hover:bg-slate-200">{label}</a>
        ))}
      </nav>

      <section id="overview">
        <Card>
          <CardHeader title="Overview" subtitle="Strategy records come from crawled site data and configured research sources; unavailable third-party metrics are never estimated." />
          <CardBody>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
              <Stat label="Keywords" value={data.keywords.length} />
              <Stat label="Clusters" value={data.clusters.length} />
              <Stat label="Opportunities" value={data.opportunities.length} />
              <Stat label="Cannibalization" value={data.cannibalization.length} />
              <Stat label="Internal links" value={data.internalLinks.length} />
              <Stat label="Plan items" value={data.plan.length} />
            </div>
          </CardBody>
        </Card>
      </section>

      <section id="keywords">
        <Card>
          <CardHeader title="Keywords" subtitle="Search intent and source-backed keyword metrics." />
          <CardBody className="overflow-x-auto px-0">
            <table className={tableClass}>
              <thead><tr><th className={thClass}>Keyword</th><th className={thClass}>Intent</th><th className={thClass}>Cluster</th><th className={thClass}>Volume</th><th className={thClass}>Difficulty</th><th className={thClass}>CPC</th><th className={thClass}>Source</th><th className={thClass}>Review</th></tr></thead>
              <tbody>
                {data.keywords.length === 0 && <EmptyRows columns={8}>No keyword research is available yet.</EmptyRows>}
                {data.keywords.map((keyword) => (
                  <KeywordRow key={keyword.id} keyword={keyword} websiteId={websiteId} clusters={clusterOptions} intents={intentOptions} priorities={priorityOptions} canEdit={canEdit} />
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      </section>

      <section id="clusters">
        <Card>
          <CardHeader title="Clusters" subtitle="Topic groups and pillar opportunities." />
          <CardBody className="overflow-x-auto px-0">
            <table className={tableClass}>
              <thead><tr><th className={thClass}>Cluster</th><th className={thClass}>Primary keyword</th><th className={thClass}>Intent</th><th className={thClass}>Keywords</th><th className={thClass}>Pillar page</th><th className={thClass}>Review</th></tr></thead>
              <tbody>
                {data.clusters.length === 0 && <EmptyRows columns={6}>No topic clusters are available yet.</EmptyRows>}
                {data.clusters.map((cluster) => <ClusterRow key={cluster.id} cluster={cluster} websiteId={websiteId} canEdit={canEdit} />)}
              </tbody>
            </table>
          </CardBody>
        </Card>
      </section>

      <section id="opportunities">
        <Card>
          <CardHeader title="Opportunities" subtitle="Content gaps and recommended actions. Approved opportunities can generate a draft (never published in Phase 4)." />
          <CardBody className="space-y-3">
            {data.opportunities.length === 0 && <p className="py-6 text-center text-sm text-slate-500">No content opportunities are available yet.</p>}
            {data.opportunities.map((item) => (
              <OpportunityCard key={item.id} item={item} websiteId={websiteId} clusters={clusterOptions} priorities={priorityOptions} canEdit={canEdit} content={content} />
            ))}
          </CardBody>
        </Card>
      </section>

      <section id="cannibalization">
        <Card>
          <CardHeader title="Cannibalization" subtitle="Keywords targeted by competing pages on this website." />
          <CardBody className="space-y-3">
            {data.cannibalization.length === 0 && <p className="py-6 text-center text-sm text-slate-500">No cannibalization conflicts were found.</p>}
            {data.cannibalization.map((item) => <CannibalizationCard key={item.id} item={item} websiteId={websiteId} canEdit={canEdit} />)}
          </CardBody>
        </Card>
      </section>

      <section id="internal-linking">
        <Card>
          <CardHeader title="Internal Linking" subtitle="Suggested links derived from the crawled page graph and topical relationships." />
          <CardBody className="overflow-x-auto px-0">
            <table className={tableClass}>
              <thead><tr><th className={thClass}>Source</th><th className={thClass}>Target</th><th className={thClass}>Anchor</th><th className={thClass}>Reason</th><th className={thClass}>Priority</th><th className={thClass}>Review</th></tr></thead>
              <tbody>
                {data.internalLinks.length === 0 && <EmptyRows columns={6}>No internal linking opportunities are available yet.</EmptyRows>}
                {data.internalLinks.map((item) => <InternalLinkRow key={item.id} item={item} websiteId={websiteId} priorities={priorityOptions} canEdit={canEdit} />)}
              </tbody>
            </table>
          </CardBody>
        </Card>
      </section>

      <section id="30-60-90-plan">
        <Card>
          <CardHeader title="30/60/90 Plan" subtitle="Approve or skip each recommended action before execution." />
          <CardBody className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {(["30", "60", "90"] as const).map((horizon) => (
              <PlanColumn key={horizon} horizon={horizon} items={data.plan.filter((item) => planHorizon(item) === horizon)} websiteId={websiteId} canEdit={canEdit} content={content} />
            ))}
          </CardBody>
        </Card>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-lg bg-slate-50 p-3"><div className="text-2xl font-semibold text-slate-900">{value}</div><div className="text-xs uppercase tracking-wide text-slate-500">{label}</div></div>;
}

function KeywordRow({ keyword, websiteId, clusters, intents, priorities, canEdit }: { keyword: StrategyKeyword; websiteId: string; clusters: Array<{ value: string; label: string }>; intents: Array<{ value: string; label: string }>; priorities: Array<{ value: string; label: string }>; canEdit: boolean }) {
  return <tr><td className={tdClass}><div className="font-medium text-slate-900">{keyword.keyword}</div><div className="mt-1"><ChangeSelect websiteId={websiteId} recordId={keyword.id} collection="keywords" operation="change_priority" value={keyword.priority} values={priorities} canEdit={canEdit} /></div></td><td className={tdClass}><ChangeSelect websiteId={websiteId} recordId={keyword.id} collection="keywords" operation="change_intent" value={keyword.intent} values={intents} canEdit={canEdit} /></td><td className={tdClass}><ChangeSelect websiteId={websiteId} recordId={keyword.id} collection="keywords" operation="change_cluster" value={keyword.cluster} values={clusters} canEdit={canEdit} /></td><td className={tdClass}>{metric(keyword.search_volume)}</td><td className={tdClass}>{metric(keyword.keyword_difficulty)}</td><td className={tdClass}>{metric(keyword.cpc)}</td><td className={tdClass}>{display(keyword.metrics_source || keyword.source)}</td><td className={tdClass}><DecisionButtons websiteId={websiteId} recordId={keyword.id} collection="keywords" status={keyword.status} canEdit={canEdit} /></td></tr>;
}

function ClusterRow({ cluster, websiteId, canEdit }: { cluster: TopicCluster; websiteId: string; canEdit: boolean }) {
  return <tr><td className={tdClass}><div className="font-medium text-slate-900">{cluster.name}</div><div className="max-w-xs text-xs text-slate-500">{cluster.description}</div></td><td className={tdClass}>{display(cluster.expand?.pillar_keyword?.keyword || cluster.primary_topic)}</td><td className={tdClass}>{display(cluster.expand?.pillar_keyword?.intent)}</td><td className={tdClass}>{metric(cluster.keyword_count)}</td><td className={tdClass}>{display(cluster.expand?.pillar_page?.url || cluster.pillar_page)}</td><td className={tdClass}><DecisionButtons websiteId={websiteId} recordId={cluster.id} collection="clusters" status={cluster.status} canEdit={canEdit} /></td></tr>;
}

type ContentLinks = { byKey: Record<string, { id: string; status: string }>; byOpportunity: Record<string, { id: string; status: string }> };

const NON_CONTENT_OPPORTUNITIES = ["internal_link", "ignore"];
const NON_CONTENT_PLAN_ACTIONS = ["add_internal_links", "fix_technical_issue", "ignore"];

/** "Generate Content" for approved sources; "Open Draft" once an article exists (no duplicates). */
function ContentButton({ websiteId, kind, id, status, typeOrAction, opportunity, content, canEdit }: { websiteId: string; kind: "opportunity" | "plan_item"; id: string; status?: string; typeOrAction?: string; opportunity?: string; content: ContentLinks; canEdit: boolean }) {
  const existing = content.byKey[`${kind === "opportunity" ? "opp" : "plan"}:${id}`] ?? (kind === "opportunity" ? content.byOpportunity[id] : opportunity ? content.byOpportunity[opportunity] : undefined);
  if (existing) return <Link href={`/articles/${existing.id}`} className="text-xs font-medium text-sky-700 hover:underline">Open Draft ({existing.status.replaceAll("_", " ")})</Link>;
  const blocked = kind === "opportunity" ? NON_CONTENT_OPPORTUNITIES.includes(String(typeOrAction)) : NON_CONTENT_PLAN_ACTIONS.includes(String(typeOrAction));
  const approved = kind === "opportunity" ? status === "approved" : status === "approved" || status === "in_progress";
  if (!canEdit || blocked || !approved) return null;
  return <Link href={`/websites/${websiteId}/content/generate?source=${kind}&sid=${id}`} className="inline-flex rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-800">Generate Content</Link>;
}

function OpportunityCard({ item, websiteId, clusters, priorities, canEdit, content }: { item: ContentOpportunity; websiteId: string; clusters: Array<{ value: string; label: string }>; priorities: Array<{ value: string; label: string }>; canEdit: boolean; content: ContentLinks }) {
  const keyword = item.expand?.keyword;
  return <article className="rounded-lg border border-slate-200 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="font-semibold text-slate-900">{display(item.title_suggestion || item.recommended_url)}</h4><p className="text-xs text-slate-500">Target: {display(keyword?.keyword)} · Volume: {metric(keyword?.search_volume)} · Difficulty: {metric(keyword?.keyword_difficulty)}</p></div><div className="flex flex-col items-end gap-2"><DecisionButtons websiteId={websiteId} recordId={item.id} collection="opportunities" status={item.status} canEdit={canEdit} /><ContentButton websiteId={websiteId} kind="opportunity" id={item.id} status={item.status} typeOrAction={item.opportunity_type} content={content} canEdit={canEdit} /></div></div>{item.reason && <p className="mt-2 text-sm text-slate-600">{item.reason}</p>}<div className="mt-3 grid gap-2 md:grid-cols-4"><div className="rounded border border-slate-200 px-2 py-1 text-xs">Intent: {display(intentLabel(keyword?.intent))}</div><div className="rounded border border-slate-200 px-2 py-1 text-xs">Page: {display(pageTypeLabel(item.recommended_page_type))}</div><ChangeSelect websiteId={websiteId} recordId={item.id} collection="opportunities" operation="change_cluster" value={item.cluster} values={clusters} canEdit={canEdit} /><ChangeSelect websiteId={websiteId} recordId={item.id} collection="opportunities" operation="change_priority" value={item.priority} values={priorities} canEdit={canEdit} /><ChangeSelect websiteId={websiteId} recordId={item.id} collection="opportunities" operation="change_action" value={item.opportunity_type} values={OPPORTUNITY_ACTIONS.map((value) => ({ value, label: opportunityLabel(value) }))} canEdit={canEdit} /></div></article>;
}

function ActionEditor({ websiteId, recordId, collection, value, canEdit }: { websiteId: string; recordId: string; collection: CollectionKey; value?: string; canEdit: boolean }) {
  if (!canEdit) return <p className="mt-3 text-sm text-slate-600"><strong>Action:</strong> {display(value)}</p>;
  return <form action={updateStrategyRecordAction} className="mt-3 flex gap-2"><HiddenRecord websiteId={websiteId} recordId={recordId} collection={collection} /><input type="hidden" name="operation" value="change_action" /><input name="value" defaultValue={value} placeholder="Recommended action" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" /><Button type="submit" variant="secondary">Save action</Button></form>;
}

function pages(item: CannibalizationIssue): string[] {
  return item.expand?.pages?.map((page) => page.url) ?? item.pages ?? [];
}

function CannibalizationCard({ item, websiteId, canEdit }: { item: CannibalizationIssue; websiteId: string; canEdit: boolean }) {
  return <article className="rounded-lg border border-slate-200 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h4 className="font-semibold text-slate-900">{item.keyword_group}</h4>{item.severity && <Badge tone={tone(item.severity)}>{item.severity}</Badge>}</div><ul className="mt-2 list-disc pl-5 text-xs text-slate-600">{pages(item).length ? pages(item).map((page) => <li key={page} className="break-all">{page}</li>) : <li>Competing pages: Not available</li>}</ul></div><DecisionButtons websiteId={websiteId} recordId={item.id} collection="cannibalization" status={item.status} canEdit={canEdit} /></div><ActionEditor websiteId={websiteId} recordId={item.id} collection="cannibalization" value={item.recommended_action} canEdit={canEdit} /></article>;
}

function InternalLinkRow({ item, websiteId, priorities, canEdit }: { item: InternalLinkOpportunity; websiteId: string; priorities: Array<{ value: string; label: string }>; canEdit: boolean }) {
  return <tr><td className={`${tdClass} max-w-xs break-all`}>{display(item.source_url || item.source_page)}</td><td className={`${tdClass} max-w-xs break-all`}>{display(item.target_url || item.target_page)}</td><td className={tdClass}>{display(item.anchor_text)}</td><td className={`${tdClass} max-w-xs`}>{display(item.reason)}</td><td className={tdClass}><ChangeSelect websiteId={websiteId} recordId={item.id} collection="internalLinks" operation="change_priority" value={item.priority} values={priorities} canEdit={canEdit} /></td><td className={tdClass}><DecisionButtons websiteId={websiteId} recordId={item.id} collection="internalLinks" status={item.status} canEdit={canEdit} /></td></tr>;
}

function planHorizon(item: StrategyPlanItem): "30" | "60" | "90" | "" {
  const value = String(item.scheduled_period || "");
  if (value === "days_1_30") return "30";
  if (value === "days_31_60") return "60";
  if (value === "days_61_90") return "90";
  return "";
}

function PlanColumn({ horizon, items, websiteId, canEdit, content }: { horizon: "30" | "60" | "90"; items: StrategyPlanItem[]; websiteId: string; canEdit: boolean; content: ContentLinks }) {
  return <div><h4 className="mb-3 text-sm font-semibold text-slate-900">{horizon === "30" ? "Days 1–30" : horizon === "60" ? "Days 31–60" : "Days 61–90"}</h4><div className="space-y-3">{items.length === 0 && <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">No actions scheduled.</p>}{items.map((item) => <article key={item.id} className="rounded-lg border border-slate-200 p-3"><div className="flex items-center justify-between gap-2"><h5 className="text-sm font-medium text-slate-900">{display(item.proposed_title || item.action)}</h5>{item.priority && <Badge tone={tone(item.priority)}>{item.priority}</Badge>}</div>{item.reason && <p className="mt-1 text-xs text-slate-600">{item.reason}</p>}<p className="mt-2 text-xs text-slate-500">{display(item.proposed_url || item.action)}{item.page_type ? ` · ${pageTypeLabel(item.page_type)}` : ""}</p><div className="mt-3 flex items-center gap-2"><Badge tone={tone(item.status)}>{item.status || "planned"}</Badge><ContentButton websiteId={websiteId} kind="plan_item" id={item.id} status={item.status} typeOrAction={item.action} opportunity={item.opportunity} content={content} canEdit={canEdit} />{canEdit && item.status !== "in_progress" && <><form action={updateStrategyRecordAction}><HiddenRecord websiteId={websiteId} recordId={item.id} collection="plan" /><input type="hidden" name="operation" value="approve" /><button type="submit" className="text-xs font-medium text-emerald-700">Approve</button></form><form action={updateStrategyRecordAction}><HiddenRecord websiteId={websiteId} recordId={item.id} collection="plan" /><input type="hidden" name="operation" value="skip" /><button type="submit" className="text-xs font-medium text-slate-500">Skip</button></form></>}</div></article>)}</div></div>;
}
