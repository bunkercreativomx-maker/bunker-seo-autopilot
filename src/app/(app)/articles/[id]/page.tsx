import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser, canWrite } from "@/lib/pocketbase/auth";
import { getArticleBundle } from "@/lib/pocketbase/content";
import { approvalBlockers, diffLines } from "@/lib/content/core";
import { formatDateTime } from "@/lib/format";
import { Badge, Card, CardBody, CardHeader, Field, Input, Textarea } from "@/components/ui";
import { ActionForm } from "@/components/content/action-form";
import { ContentJobProgress } from "@/components/content/job-progress";
import { Markdown } from "@/components/content/markdown";
import { articleTone, qaTone } from "@/components/content/article-list";
import {
  approveArticleAction, continueAfterBriefAction, recheckArticleAction, rejectArticleAction, requestRevisionAction,
  restoreVersionAction, retryGenerationAction, saveArticleAction, saveBriefAction,
} from "@/app/actions/content";
import { ARTICLE_STATUS_LABELS, CONTENT_TYPE_LABELS, JOB_STEP_LABELS } from "@/lib/content/types";
import { ArticlePublishing } from "@/components/publishing/article-publishing";
import { getPublication, listPublicationEvents, listPublishJobs, publishPreview, rollbackCandidates } from "@/lib/pocketbase/publishing";

export const dynamic = "force-dynamic";

const TABS = ["content", "preview", "research", "sources", "brief", "outline", "seo", "links", "claims", "qa", "history", "publishing"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = { content: "Content", preview: "Preview", research: "Research", sources: "Sources", brief: "Brief", outline: "Outline", seo: "SEO", links: "Internal Links", claims: "Claims", qa: "QA", history: "History", publishing: "Publishing" };

function Json({ value }: { value: unknown }) {
  return <pre className="max-h-[480px] overflow-auto rounded-lg bg-slate-50 p-3 text-xs text-slate-700">{JSON.stringify(value ?? null, null, 2)}</pre>;
}
function List({ items, empty = "—" }: { items?: string[] | null; empty?: string }) {
  if (!items?.length) return <p className="text-sm text-slate-500">{empty}</p>;
  return <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">{items.map((x, i) => <li key={i}>{typeof x === "string" ? x : JSON.stringify(x)}</li>)}</ul>;
}
function claimTone(status: string): "slate" | "green" | "amber" | "red" | "blue" {
  if (status === "VERIFIED") return "green";
  if (status === "SUPPORTED") return "blue";
  if (status === "UNVERIFIED") return "amber";
  if (status === "CONTRADICTED") return "red";
  return "slate";
}

export default async function ArticlePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; compare?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(String(sp.tab)) ? (sp.tab as Tab) : "content";
  const { pb, user } = await requireUser();
  const bundle = await getArticleBundle(pb, id);
  if (!bundle) notFound();
  const { article: a, versions, jobs, research, sources, claims, links, qa, usage } = bundle;
  const editable = canWrite(user.role);
  const activeJob = jobs.find((j) => j.status === "queued" || j.status === "running");
  const lastJob = jobs[0];
  const PUBLISH_STATES = ["approved", "publish_queued", "publishing", "published", "publish_failed", "unpublished"];
  // Approved/published content is edited only by creating a new version (manual edit
  // re-opens review on the ARTICLE; the live publication keeps its locked version).
  const locked = a.status === "rejected" || ["publish_queued", "publishing"].includes(a.status) || a.status === "approved" || Boolean(activeJob);
  const publishing = tab === "publishing"
    ? await Promise.all([publishPreview(pb, a.id, a.website), getPublication(pb, a.id), listPublicationEvents(pb, a.id), listPublishJobs(pb, `article = "${a.id}"`, 20), rollbackCandidates(pb, a.id)])
    : null;
  const blockers = approvalBlockers(a as unknown as Record<string, unknown> & { id: string });
  const hidden = { articleId: a.id, websiteId: a.website };
  const brief = (a.brief ?? {}) as Record<string, unknown>;
  const provenance = (a.provenance ?? {}) as Record<string, unknown>;
  const flags = a.flags ?? [];
  const tabHref = (t: Tab) => `/articles/${a.id}?tab=${t}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs text-slate-500">
            <Link href={`/clients/${a.client}/content`} className="hover:text-slate-700">{a.expand?.client?.business_name ?? "Client"}</Link>
            {" · "}
            <Link href={`/websites/${a.website}/content`} className="hover:text-slate-700">{a.expand?.website?.name ?? "Website"}</Link>
            {" · "}{CONTENT_TYPE_LABELS[a.content_type]} · {a.language}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{a.title || a.primary_keyword || "Untitled draft"}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone={articleTone(a.status)}>{ARTICLE_STATUS_LABELS[a.status] ?? a.status}</Badge>
            {a.qa_status && a.qa_status !== "pending" && <Badge tone={qaTone(a.qa_status)}>QA {a.qa_status}</Badge>}
            {a.fact_check_status && a.fact_check_status !== "pending" && <Badge tone={a.fact_check_status === "passed" ? "green" : a.fact_check_status === "blocked" ? "red" : "amber"}>Fact check {a.fact_check_status}</Badge>}
            <span className="text-xs text-slate-500">v{a.current_version ?? 0} · keyword “{a.primary_keyword}”{a.target_location ? ` · ${a.target_location}` : ""}</span>
          </div>
          {flags.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{flags.map((f) => <span key={f} className="rounded bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-amber-200">{f}</span>)}</div>}
        </div>
        <Card className="min-w-[240px]">
          <CardBody className="space-y-1 text-xs text-slate-600">
            <p className="font-semibold text-slate-900">AI cost for this article</p>
            <p>AI calls: <strong>{usage.calls}</strong></p>
            <p>Input tokens: <strong>{usage.input_tokens.toLocaleString()}</strong></p>
            <p>Output tokens: <strong>{usage.output_tokens.toLocaleString()}</strong></p>
            <p>Estimated cost: <strong>{usage.estimated_cost === null ? "not available (pricing not configured)" : `$${usage.estimated_cost.toFixed(4)}`}</strong>{usage.unpriced_calls > 0 && usage.estimated_cost !== null ? ` (+${usage.unpriced_calls} unpriced)` : ""}</p>
          </CardBody>
        </Card>
      </div>

      <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
        {PUBLISH_STATES.includes(a.status) ? "Publishing is manual: Approved → Publish (with confirmation) → worker publishes and verifies. See the Publishing tab." : "Not published. Draft → QA → human approval → Publish."}
      </div>

      {(activeJob || lastJob?.status === "failed") && (
        <ContentJobProgress
          jobId={(activeJob ?? lastJob).id}
          initial={{ status: (activeJob ?? lastJob).status, step: (activeJob ?? lastJob).step ?? "queued", progress: (activeJob ?? lastJob).progress ?? 0, error: (activeJob ?? lastJob).error, error_code: (activeJob ?? lastJob).error_code }}
        />
      )}

      {editable && !activeJob && (
        <div className="flex flex-wrap gap-3">
          {a.status === "failed" && <ActionForm action={retryGenerationAction} hidden={hidden} submitLabel="Retry" pendingLabel="Queueing…" />}
          {a.status === "needs_revision" && (
            <ActionForm
              action={retryGenerationAction}
              hidden={{ ...hidden, mode: "regenerate" }}
              submitLabel="Retry (regenerate)"
              pendingLabel="Queueing…"
              confirm="Regenerate this article? A new version is created; previous versions are kept."
            >
              <div className="flex flex-wrap gap-3 text-xs text-slate-600">
                <label className="flex flex-col gap-1">Primary keyword
                  <input name="primary_keyword" defaultValue={a.primary_keyword ?? ""} className="rounded border border-slate-300 px-2 py-1 text-sm" required minLength={2} maxLength={200} />
                </label>
                <label className="flex flex-col gap-1">Target location
                  <input name="target_location" defaultValue={a.target_location ?? ""} className="rounded border border-slate-300 px-2 py-1 text-sm" maxLength={200} />
                </label>
              </div>
            </ActionForm>
          )}
          {a.status === "brief_ready" && (a.pipeline_state as Record<string, unknown> | null)?.awaiting_brief_review ? <ActionForm action={continueAfterBriefAction} hidden={hidden} submitLabel="Continue to outline & draft" /> : null}
          {a.content && !["approved", "rejected", "awaiting_approval"].includes(a.status) && <ActionForm action={recheckArticleAction} hidden={hidden} variant="secondary" submitLabel="Run fact check + QA on current version" />}
        </div>
      )}

      <nav className="flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <Link key={t} href={tabHref(t)} className={`rounded-t-lg px-3 py-2 text-sm font-medium ${t === tab ? "border-b-2 border-slate-900 text-slate-900" : "text-slate-500 hover:text-slate-700"}`}>
            {TAB_LABELS[t]}{t === "claims" && claims.length ? ` (${claims.length})` : ""}{t === "sources" && sources.length ? ` (${sources.length})` : ""}{t === "history" ? ` (${versions.length})` : ""}
          </Link>
        ))}
      </nav>

      {tab === "content" && (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Card>
              <CardHeader title="Content" subtitle={locked ? "Read-only (approved, rejected, or a job is running)." : "Saving creates a new version (manual_edit). QA must re-run before approval."} />
              <CardBody>
                {editable && !locked ? (
                  <ActionForm action={saveArticleAction} hidden={hidden} submitLabel="Save as new version" pendingLabel="Saving…">
                    <div className="grid gap-3 md:grid-cols-2">
                      <Field label="Title"><Input name="title" defaultValue={a.title ?? ""} maxLength={300} /></Field>
                      <Field label="Slug"><Input name="slug" defaultValue={a.slug ?? ""} maxLength={120} pattern="[a-z0-9]+(-[a-z0-9]+)*" /></Field>
                      <Field label="SEO title"><Input name="seo_title" defaultValue={a.seo_title ?? ""} maxLength={200} /></Field>
                      <Field label="Meta description"><Input name="meta_description" defaultValue={a.meta_description ?? ""} maxLength={400} /></Field>
                    </div>
                    <div className="mt-3"><Field label="Excerpt"><Textarea name="excerpt" defaultValue={a.excerpt ?? ""} rows={2} maxLength={600} /></Field></div>
                    <div className="mt-3"><Field label="Content (Markdown)"><Textarea name="content" defaultValue={a.content ?? ""} rows={28} className="font-mono text-xs" /></Field></div>
                    <div className="mt-3"><Field label="Change note (optional)"><Input name="change_reason" maxLength={500} /></Field></div>
                  </ActionForm>
                ) : (
                  <div className="space-y-2 text-sm">
                    <p><span className="text-slate-500">Slug:</span> {a.slug || "—"}</p>
                    <p><span className="text-slate-500">SEO title:</span> {a.seo_title || "—"}</p>
                    <p><span className="text-slate-500">Meta description:</span> {a.meta_description || "—"}</p>
                    <p><span className="text-slate-500">Excerpt:</span> {a.excerpt || "—"}</p>
                    <pre className="mt-3 max-h-[640px] overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs">{a.content || "No draft yet."}</pre>
                  </div>
                )}
              </CardBody>
            </Card>
            {a.content_type === "existing_page_optimization" && a.existing_content && (
              <Card className="mt-6">
                <CardHeader title="Existing vs Proposed" subtitle="The live page is not modified in Phase 4." />
                <CardBody className="grid gap-4 md:grid-cols-2">
                  <div><p className="mb-2 text-xs font-semibold uppercase text-slate-500">Existing (crawled)</p><pre className="max-h-[560px] overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs">{a.existing_content}</pre></div>
                  <div><p className="mb-2 text-xs font-semibold uppercase text-slate-500">Proposed</p><pre className="max-h-[560px] overflow-auto whitespace-pre-wrap rounded bg-emerald-50 p-3 text-xs">{a.content}</pre></div>
                </CardBody>
              </Card>
            )}
          </div>
          <div className="space-y-6">
            <Card>
              <CardHeader title="Review" subtitle="Human decision — the writer cannot approve its own content." />
              <CardBody className="space-y-5">
                {a.approved_at && PUBLISH_STATES.includes(a.status) && <p className="text-sm text-emerald-700">Approved v{String((a as unknown as { approved_version?: number }).approved_version ?? "")} by {a.expand?.approved_by?.name || a.expand?.approved_by?.email || a.approved_by} on {formatDateTime(a.approved_at)}. <Link className="underline" href={tabHref("publishing")}>Publishing →</Link></p>}
                {a.status === "rejected" && <p className="text-sm text-rose-700">Rejected on {formatDateTime(a.rejected_at)}: {a.rejection_reason}</p>}
                {editable && a.status === "awaiting_approval" && !activeJob && (
                  <ActionForm action={approveArticleAction} hidden={hidden} submitLabel="Approve" pendingLabel="Approving…">
                    {blockers.length > 0 && <List items={blockers} />}
                    {a.high_risk && <label className="flex items-start gap-2 text-xs text-amber-800"><input type="checkbox" name="ack_high_risk" className="mt-0.5" />HIGH_RISK_REVIEW_REQUIRED ({(a.risk_categories ?? []).join(", ") || "regulated"}): I reviewed these claims.</label>}
                    {a.qa_status === "NEEDS_REVISION" && <label className="flex items-start gap-2 text-xs text-amber-800"><input type="checkbox" name="ack_warnings" className="mt-0.5" />QA still reports issues; I reviewed them.</label>}
                  </ActionForm>
                )}
                {editable && a.status !== "awaiting_approval" && a.status !== "approved" && a.status !== "rejected" && blockers.length > 0 && (
                  <div><p className="text-xs font-semibold text-slate-600">Why it cannot be approved yet</p><List items={blockers} /></div>
                )}
                {editable && a.content && a.status !== "rejected" && !activeJob && (
                  <ActionForm action={requestRevisionAction} hidden={hidden} variant="secondary" submitLabel="Request Revision" pendingLabel="Queueing…">
                    <Field label="Revision instruction"><Textarea name="instruction" rows={3} maxLength={2000} placeholder="e.g. Make the introduction shorter. Do not mention financing." required /></Field>
                  </ActionForm>
                )}
                {editable && !["approved", "rejected"].includes(a.status) && !activeJob && (
                  <ActionForm action={rejectArticleAction} hidden={hidden} variant="danger" submitLabel="Reject" confirm="Reject this content? It will remain stored.">
                    <Field label="Rejection reason (required)"><Input name="reason" minLength={3} maxLength={2000} required /></Field>
                  </ActionForm>
                )}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Provenance" />
              <CardBody className="space-y-1 text-xs text-slate-600">
                <p>Generated by: {String(provenance.generated_by ?? "—")}</p>
                <p>Generated at: {formatDateTime(String(provenance.generated_at ?? ""))}</p>
                <p>Provider: {String(provenance.provider ?? "—")}</p>
                <p>Source: {a.content_opportunity ? `opportunity ${a.content_opportunity}` : a.content_plan_item ? `plan item ${a.content_plan_item}` : "—"}</p>
                <p>Strategy version: {String(provenance.strategy_version ?? "—")}</p>
                <p>Research: {a.research || "—"}</p>
                {provenance.models ? <details><summary className="cursor-pointer">Models by task</summary><Json value={provenance.models} /></details> : null}
              </CardBody>
            </Card>
          </div>
        </div>
      )}

      {tab === "preview" && (
        <Card>
          <CardBody className="mx-auto max-w-3xl py-8">
            <p className="mb-4 text-center text-[11px] uppercase tracking-wide text-slate-400">Preview only — not published</p>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">{a.title || (a.outline?.h1 ?? "")}</h1>
            {a.excerpt && <p className="mt-2 text-lg text-slate-500">{a.excerpt}</p>}
            <div className="my-6 flex aspect-[16/7] items-center justify-center rounded-xl bg-slate-100 text-sm text-slate-400">{a.featured_image ? `Featured image: ${a.featured_image}` : "Featured image placeholder"}</div>
            <Markdown source={a.content ?? ""} skipFirstH1 />
          </CardBody>
        </Card>
      )}

      {tab === "research" && (
        <Card>
          <CardHeader title="Research" subtitle={research ? `${research.research_status ?? ""} — ${research.research_notes ?? ""}` : "No research yet."} />
          {research && (
            <CardBody className="grid gap-6 md:grid-cols-2">
              <div className="space-y-4 text-sm">
                <div><p className="text-xs font-semibold uppercase text-slate-500">Search intent</p><p>{research.search_intent || "—"}</p></div>
                <div><p className="text-xs font-semibold uppercase text-slate-500">Audience</p><p>{research.audience || "—"}</p></div>
                <div><p className="text-xs font-semibold uppercase text-slate-500">Recommended angle</p><p>{research.recommended_angle || "—"}</p></div>
                <div><p className="text-xs font-semibold uppercase text-slate-500">Questions to answer</p><List items={research.questions} /></div>
                <div><p className="text-xs font-semibold uppercase text-slate-500">Existing content on the site</p><p>{research.existing_content_summary || "—"}</p></div>
                <div><p className="text-xs font-semibold uppercase text-slate-500">Content gaps</p><List items={research.content_gaps} /></div>
              </div>
              <div className="space-y-4 text-sm">
                <div><p className="text-xs font-semibold uppercase text-slate-500">Required facts</p>
                  {(research.facts ?? []).length === 0 ? <p className="text-slate-500">—</p> : <ul className="space-y-1">{(research.facts ?? []).map((f, i) => <li key={i}><Badge tone={f.availability === "verified_fact" ? "green" : f.availability === "missing" ? "red" : "amber"}>{f.availability}</Badge> {f.fact} <span className="text-xs text-slate-400">{f.evidence_ids?.join(", ")}</span></li>)}</ul>}
                </div>
                <div><p className="text-xs font-semibold uppercase text-slate-500">Claims requiring external sources</p><List items={research.risks?.claims_requiring_sources} /></div>
                <div><p className="text-xs font-semibold uppercase text-rose-600">Do NOT claim</p><List items={research.do_not_claim} /></div>
                <div><p className="text-xs font-semibold uppercase text-slate-500">Risks</p><List items={[...(research.risks?.items ?? []), ...((research.risks?.categories ?? []).map((c) => `category: ${c}`))]} /></div>
                <div><p className="text-xs font-semibold uppercase text-slate-500">Internal pages to reference</p><List items={(research.internal_link_candidates ?? []).map((c) => `${c.title || c.candidate_id} ${c.url ? `(${c.url})` : ""} — ${c.reason}`)} /></div>
              </div>
            </CardBody>
          )}
        </Card>
      )}

      {tab === "sources" && (
        <Card>
          <CardHeader title="Research sources" subtitle="Collected by the research provider and fetched through SSRF protection. The writer cannot add sources." />
          <CardBody className="overflow-x-auto px-0">
            {sources.length === 0 ? <p className="px-5 text-sm text-slate-500">No external sources. {research?.research_notes}</p> : (
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50"><tr>{["Source", "Publisher", "Type", "Quality", "Access", "Retrieved", "Notes"].map((h) => <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase text-slate-500">{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {sources.map((s) => (
                    <tr key={s.id}>
                      <td className="max-w-md px-4 py-2"><a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="font-medium text-sky-700 hover:underline">{s.title || s.url}</a><p className="break-all text-xs text-slate-400">{s.url}</p></td>
                      <td className="px-4 py-2">{s.publisher || "—"}</td>
                      <td className="px-4 py-2"><Badge tone={["government", "official", "institution"].includes(s.source_type) ? "green" : "slate"}>{s.source_type}</Badge></td>
                      <td className="px-4 py-2">{s.quality ?? "—"}</td>
                      <td className="px-4 py-2">{s.verified_access ? <Badge tone="green">fetched</Badge> : <Badge tone="amber">{s.http_status || "not fetched"}</Badge>}</td>
                      <td className="px-4 py-2 text-xs">{formatDateTime(s.retrieved_at)}</td>
                      <td className="max-w-xs px-4 py-2 text-xs text-slate-500">{s.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>
      )}

      {tab === "brief" && (
        <Card>
          <CardHeader title="Content brief" subtitle={editable && !locked && !a.content ? "You can edit the brief before drafting." : undefined} />
          <CardBody className="space-y-4">
            {!a.brief ? <p className="text-sm text-slate-500">No brief yet.</p> : (
              <div className="grid gap-4 text-sm md:grid-cols-2">
                {[["Primary keyword", brief.primary_keyword], ["Intent", brief.intent], ["Audience", brief.audience], ["Content type", brief.content_type], ["Goal", brief.goal], ["Conversion goal", brief.conversion_goal], ["Target location", brief.target_location], ["Angle", brief.angle], ["CTA", brief.cta]].map(([k, v]) => <div key={String(k)}><p className="text-xs font-semibold uppercase text-slate-500">{String(k)}</p><p>{String(v ?? "—") || "—"}</p></div>)}
                <div><p className="text-xs font-semibold uppercase text-slate-500">Secondary keywords</p><List items={brief.secondary_keywords as string[]} /></div>
                <div><p className="text-xs font-semibold uppercase text-slate-500">Key questions</p><List items={brief.key_questions as string[]} /></div>
                <div><p className="text-xs font-semibold uppercase text-slate-500">Required sections</p><List items={((brief.required_sections as Array<{ heading_idea: string; purpose: string }>) ?? []).map((s) => `${s.heading_idea} — ${s.purpose}`)} /></div>
                <div><p className="text-xs font-semibold uppercase text-slate-500">Business facts</p><List items={((brief.business_facts as Array<{ statement: string; evidence_id: string }>) ?? []).map((f) => `${f.statement} [${f.evidence_id}]`)} /></div>
                <div><p className="text-xs font-semibold uppercase text-slate-500">External facts</p><List items={((brief.external_facts as Array<{ statement: string; evidence_id: string }>) ?? []).map((f) => `${f.statement} [${f.evidence_id}]`)} /></div>
                <div><p className="text-xs font-semibold uppercase text-rose-600">Things to avoid</p><List items={brief.things_to_avoid as string[]} /></div>
                <div><p className="text-xs font-semibold uppercase text-slate-500">Target length</p><p>{brief.target_length ? JSON.stringify(brief.target_length) : "—"}</p></div>
              </div>
            )}
            {editable && a.brief && !locked && !a.content && (
              <ActionForm action={saveBriefAction} hidden={hidden} variant="secondary" submitLabel="Save brief">
                <Field label="Brief (JSON)"><Textarea name="brief" rows={18} defaultValue={JSON.stringify(a.brief, null, 2)} className="font-mono text-xs" /></Field>
              </ActionForm>
            )}
          </CardBody>
        </Card>
      )}

      {tab === "outline" && (
        <Card>
          <CardHeader title="Outline" subtitle={a.outline?.cta_placement ? `CTA placement: ${a.outline.cta_placement}` : undefined} />
          <CardBody>
            {!a.outline ? <p className="text-sm text-slate-500">No outline yet.</p> : (
              <div className="space-y-2 text-sm">
                <p className="text-lg font-semibold text-slate-900">H1: {a.outline.h1}</p>
                {(a.outline.sections ?? []).map((s, i) => (
                  <div key={i} className={`rounded border border-slate-200 p-2 ${s.level === 3 ? "ml-6" : ""}`}>
                    <p className="font-medium">H{s.level}: {s.heading} {s.cta && <Badge tone="blue">CTA</Badge>}</p>
                    <p className="text-xs text-slate-500">{s.purpose}</p>
                    <p className="text-[11px] text-slate-400">Evidence: {s.evidence_ids?.join(", ") || "—"} · Links: {s.internal_link_ids?.join(", ") || "—"}</p>
                  </div>
                ))}
                {(a.outline.faq ?? []).length > 0 && <div><p className="mt-3 text-xs font-semibold uppercase text-slate-500">FAQ</p><List items={(a.outline.faq ?? []).map((f) => `${f.question} [${f.evidence_ids?.join(", ")}]`)} /></div>}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {tab === "seo" && (
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader title="SEO metadata" subtitle="No synthetic “SEO score”." />
            <CardBody className="space-y-2 text-sm">
              {[["SEO title", a.seo_title, 60], ["Meta description", a.meta_description, 160], ["Slug", a.slug, 0], ["Excerpt", a.excerpt, 0], ["Open Graph title", a.og_title, 0], ["Open Graph description", a.og_description, 0], ["Canonical", a.canonical_url, 0], ["Recommended URL", a.recommended_url, 0]].map(([k, v, max]) => (
                <div key={String(k)}><p className="text-xs font-semibold uppercase text-slate-500">{String(k)}{Number(max) > 0 && v ? ` (${String(v).length} chars)` : ""}</p><p>{String(v || "—")}</p></div>
              ))}
              <div><p className="text-xs font-semibold uppercase text-slate-500">Primary keyword</p><p>{a.primary_keyword}</p></div>
              <div><p className="text-xs font-semibold uppercase text-slate-500">Secondary keywords</p><List items={a.secondary_keywords ?? []} /></div>
              <div className="mt-4 rounded-lg border border-slate-200 p-3"><p className="text-xs text-slate-400">Search snippet preview</p><p className="text-base text-sky-800">{a.seo_title}</p><p className="text-xs text-emerald-700">{a.expand?.website?.domain}{a.slug ? ` › ${a.slug}` : ""}</p><p className="text-sm text-slate-600">{a.meta_description}</p></div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Structured data suggestions" subtitle="Stored separately; Phase 5 decides rendering." />
            <CardBody className="space-y-3">
              {(a.structured_data ?? []).length === 0 ? <p className="text-sm text-slate-500">None.</p> : (a.structured_data ?? []).map((s, i) => <div key={i}><p className="text-sm font-medium">{s.type} <span className="text-xs text-slate-500">— {s.reason}</span></p><Json value={s.jsonld} /></div>)}
            </CardBody>
          </Card>
        </div>
      )}

      {tab === "links" && (
        <Card>
          <CardHeader title="Internal links" subtitle="Validated against crawled, indexable pages of this website only." />
          <CardBody className="overflow-x-auto px-0">
            {links.length === 0 ? <p className="px-5 text-sm text-slate-500">No internal links.</p> : (
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50"><tr>{["Destination", "Anchor", "Status", "Reason", "Version"].map((h) => <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase text-slate-500">{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">{links.map((l) => <tr key={l.id}><td className="max-w-md break-all px-4 py-2">{l.destination_url}</td><td className="px-4 py-2">{l.anchor_text || "—"}</td><td className="px-4 py-2"><Badge tone={l.status === "inserted" ? "green" : l.status === "removed" ? "red" : "slate"}>{l.status}</Badge></td><td className="max-w-md px-4 py-2 text-xs text-slate-500">{l.reason}</td><td className="px-4 py-2 text-xs">v{l.version}</td></tr>)}</tbody>
              </table>
            )}
          </CardBody>
        </Card>
      )}

      {tab === "claims" && (
        <Card>
          <CardHeader title="Claims" subtitle="Extracted from the draft; business claims require verified business facts; the fact checker cannot invent citations." />
          <CardBody className="overflow-x-auto px-0">
            {claims.length === 0 ? <p className="px-5 text-sm text-slate-500">No claims extracted yet.</p> : (
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50"><tr>{["Claim", "Type", "Status", "Risk", "Source", "Notes"].map((h) => <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase text-slate-500">{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {claims.map((c) => (
                    <tr key={c.id}>
                      <td className="max-w-md px-4 py-2">{c.claim}</td>
                      <td className="px-4 py-2 text-xs">{c.claim_type}</td>
                      <td className="px-4 py-2"><Badge tone={claimTone(c.verification_status)}>{c.verification_status}</Badge></td>
                      <td className="px-4 py-2"><Badge tone={c.risk_level === "high" ? "red" : c.risk_level === "medium" ? "amber" : "slate"}>{c.risk_level}</Badge></td>
                      <td className="px-4 py-2 text-xs">{c.source || "—"}{(c.evidence_ids ?? []).length ? <p className="text-slate-400">{(c.evidence_ids ?? []).map((e) => e.ref).join(", ")}</p> : null}</td>
                      <td className="max-w-sm px-4 py-2 text-xs text-slate-500">{c.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>
      )}

      {tab === "qa" && (
        <div className="space-y-6">
          {qa.length === 0 && <Card><CardBody><p className="text-sm text-slate-500">QA has not run yet.</p></CardBody></Card>}
          {qa.slice(0, 6).map((report, index) => (
            <Card key={report.id}>
              <CardHeader title={`QA ${report.status} — v${report.version}, cycle ${report.cycle}${index === 0 ? " (latest)" : ""}`} subtitle={`${report.summary ?? ""}${report.score != null ? ` · secondary score ${report.score}` : ""}`} />
              <CardBody className="grid gap-4 md:grid-cols-2">
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase text-slate-500">Actionable issues</p>
                  {(report.issues ?? []).length === 0 ? <p className="text-sm text-slate-500">None.</p> : (
                    <ul className="space-y-2 text-sm">{(report.issues ?? []).map((i, j) => <li key={j} className="rounded border border-slate-200 p-2"><Badge tone={(i.classification ?? i.severity) === "BLOCKER" || (!i.classification && i.severity === "blocker") ? "red" : i.classification === "NOT_APPLICABLE" ? "slate" : (i.classification === "MAJOR_ADVISORY" || (!i.classification && i.severity === "major")) ? "amber" : "slate"}>{i.classification ?? i.severity}</Badge> <span className="text-xs text-slate-500">{i.check}</span><p className="mt-1">{i.description}</p>{i.fix && <p className="text-xs text-slate-500">Fix: {i.fix}</p>}</li>)}</ul>
                  )}
                  {(report.flags ?? []).length > 0 && <p className="mt-2 text-xs text-amber-700">Flags: {(report.flags ?? []).join(", ")}</p>}
                </div>
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase text-slate-500">Checks</p>
                  <ul className="space-y-1 text-xs">{(report.checks ?? []).map((c, j) => <li key={j}><Badge tone={c.status === "pass" ? "green" : c.status === "warn" ? "amber" : "red"}>{c.status}</Badge> <strong>{c.check}</strong> — {c.details}</li>)}</ul>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {tab === "publishing" && publishing && (
        <ArticlePublishing
          articleId={a.id}
          websiteId={a.website}
          status={a.status}
          editable={editable}
          preview={publishing[0]}
          publication={publishing[1]}
          events={publishing[2]}
          jobs={publishing[3]}
          candidates={publishing[4]}
        />
      )}

      {tab === "history" && (
        <div className="space-y-6">
          <Card>
            <CardHeader title="Version history" subtitle="Every AI generation, AI revision, manual edit and restore is kept." />
            <CardBody className="overflow-x-auto px-0">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50"><tr>{["Version", "Change", "Reason", "By", "When", ""].map((h) => <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase text-slate-500">{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {versions.map((v) => (
                    <tr key={v.id}>
                      <td className="px-4 py-2 font-medium">v{v.version}{v.version === a.current_version ? " (current)" : ""}</td>
                      <td className="px-4 py-2"><Badge tone={v.change_type === "manual_edit" ? "blue" : v.change_type === "restore" ? "amber" : "slate"}>{v.change_type}</Badge></td>
                      <td className="max-w-md px-4 py-2 text-xs text-slate-600">{v.change_reason}</td>
                      <td className="px-4 py-2 text-xs">{v.created_by_label || v.created_by || "worker"}</td>
                      <td className="px-4 py-2 text-xs">{formatDateTime(v.created)}</td>
                      <td className="px-4 py-2 text-xs">
                        <div className="flex items-center gap-3">
                          {v.version !== a.current_version && <Link href={`/articles/${a.id}?tab=history&compare=${v.version}`} className="text-sky-700">Compare with current</Link>}
                          {editable && v.version !== a.current_version && !locked && <ActionForm action={restoreVersionAction} hidden={{ ...hidden, version: v.version }} variant="ghost" submitLabel="Restore" confirm={`Restore v${v.version}? A new version will be created.`} />}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          </Card>
          {sp.compare && (() => {
            const other = versions.find((v) => String(v.version) === sp.compare);
            if (!other) return null;
            const diff = diffLines(other.content ?? "", a.content ?? "");
            return (
              <Card>
                <CardHeader title={`Compare v${other.version} → current (v${a.current_version})`} subtitle="Red lines removed, green lines added." />
                <CardBody>
                  <pre className="max-h-[640px] overflow-auto rounded-lg bg-slate-50 p-3 text-xs">
                    {diff.map((d, i) => <div key={i} className={d.type === "add" ? "bg-emerald-100 text-emerald-900" : d.type === "del" ? "bg-rose-100 text-rose-900 line-through" : "text-slate-600"}>{d.type === "add" ? "+ " : d.type === "del" ? "- " : "  "}{d.text}</div>)}
                  </pre>
                </CardBody>
              </Card>
            );
          })()}
          <Card>
            <CardHeader title="Content jobs" />
            <CardBody className="space-y-1 text-xs text-slate-600">
              {jobs.length === 0 ? <p>None.</p> : jobs.map((j) => <p key={j.id}><Badge tone={j.status === "completed" ? "green" : j.status === "failed" ? "red" : "slate"}>{j.status}</Badge> {j.mode} · {JOB_STEP_LABELS[j.step ?? ""] ?? j.step} · {formatDateTime(j.created)}{j.error ? ` · ${j.error_code ?? ""} ${j.error}` : ""}{j.revision_instruction ? ` · “${j.revision_instruction}”` : ""}</p>)}
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}
