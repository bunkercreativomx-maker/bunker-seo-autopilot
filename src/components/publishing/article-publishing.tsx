import { Badge, Card, CardBody, CardHeader } from "@/components/ui";
import { PublishingForm } from "@/components/publishing/publishing-form";
import { cancelPublishJobAction, publishArticleAction, rollbackPublicationAction, unpublishArticleAction, verifyPublicationAction } from "@/app/actions/publishing";
import type { ArticlePublication, PublicationEvent, PublishJob, PublishPreview } from "@/lib/publishing/types";
import { PUBLISHER_LABELS, publicationTone, type PublisherType } from "@/lib/publishing/types";
import { formatDateTime } from "@/lib/format";

/** Publishing tab of the article detail page. Every mutation requires an explicit confirmation checkbox. */
export function ArticlePublishing({
  articleId, websiteId, status, editable, preview, publication, events, jobs, candidates,
}: {
  articleId: string;
  websiteId: string;
  status: string;
  editable: boolean;
  preview: PublishPreview | null;
  publication: ArticlePublication | null;
  events: PublicationEvent[];
  jobs: PublishJob[];
  candidates: Array<{ event: string; version: number; hash: string; at: string; title: string }>;
}) {
  const hidden = { articleId, websiteId };
  const activeJob = jobs.find((j) => ["queued", "validating", "publishing", "verifying", "unpublishing"].includes(j.status));
  const canPublish = editable && !activeJob && preview && ["approved", "published", "publish_failed", "unpublished"].includes(status);
  const live = publication && ["published", "verification_required"].includes(publication.status);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Card>
          <CardHeader title="Publication" subtitle="The real, verified publication record (not just the article status)." />
          <CardBody className="space-y-2 text-sm">
            {!publication ? <p className="text-slate-500">Not published.</p> : (
              <>
                <p><span className="text-slate-500">Status:</span> <Badge tone={publicationTone(publication.status)}>{publication.status}</Badge></p>
                <p><span className="text-slate-500">Target website:</span> {publication.expand?.website?.name ?? publication.website}</p>
                <p><span className="text-slate-500">Publisher:</span> {PUBLISHER_LABELS[publication.publisher_type as PublisherType] ?? publication.publisher_type}</p>
                <p><span className="text-slate-500">Live version:</span> v{publication.article_version} <span className="text-xs text-slate-400">{publication.version_hash?.slice(0, 12)}</span></p>
                <p><span className="text-slate-500">Published:</span> {formatDateTime(publication.published_at)} {publication.expand?.published_by ? `by ${publication.expand.published_by.name || publication.expand.published_by.email}` : ""}</p>
                <p><span className="text-slate-500">Last verification:</span> {formatDateTime(publication.last_verified_at)}</p>
                {publication.public_url && publication.status === "published" && (
                  <p><a href={publication.public_url} target="_blank" rel="noopener noreferrer" className="font-medium text-sky-700 hover:underline">Open Published Page ↗</a> <span className="break-all text-xs text-slate-400">{publication.public_url}</span></p>
                )}
              </>
            )}
            {activeJob && (
              <div className="rounded border border-sky-200 bg-sky-50 p-2 text-xs text-sky-800">
                Job {activeJob.operation} is <strong>{activeJob.status}</strong> (attempt {activeJob.attempt ?? 0}/{activeJob.max_attempts ?? 3}).
                {editable && activeJob.status === "queued" && <PublishingForm action={cancelPublishJobAction} hidden={{ ...hidden, jobId: activeJob.id }} variant="ghost" submitLabel="Cancel job" />}
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Publication history" subtitle="publish · update · verify · unpublish · republish · rollback" />
          <CardBody className="overflow-x-auto px-0">
            {events.length === 0 ? <p className="px-5 text-sm text-slate-500">No events.</p> : (
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50"><tr>{["When", "Operation", "Status", "Version", "Actor", "Details"].map((h) => <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase text-slate-500">{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {events.map((e) => (
                    <tr key={e.id}>
                      <td className="px-4 py-2 text-xs">{formatDateTime(e.created_at || e.created)}</td>
                      <td className="px-4 py-2">{e.operation}</td>
                      <td className="px-4 py-2"><Badge tone={e.status === "success" ? "green" : e.status === "failed" ? "red" : "slate"}>{e.status}</Badge></td>
                      <td className="px-4 py-2 text-xs">{e.version ? `v${e.version}` : "—"}</td>
                      <td className="px-4 py-2 text-xs">{e.expand?.actor?.name || e.expand?.actor?.email || "worker"}</td>
                      <td className="max-w-sm px-4 py-2 text-xs text-slate-500">{e.details?.error_code || e.details?.reason || (e.public_url ? <span className="break-all">{e.public_url}</span> : "")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="space-y-6">
        {canPublish && preview && (
          <Card>
            <CardHeader title={preview.operation === "update" ? "Update Publication" : preview.operation === "republish" ? "Republish" : "Publish"} subtitle="Review before confirming. Phase 5 never modifies content." />
            <CardBody className="space-y-1 text-xs text-slate-700">
              <p><strong>Website:</strong> {preview.website.name} ({preview.website.domain}) · {preview.website.environment || "—"}</p>
              <p><strong>Version:</strong> v{preview.version}{preview.current_version !== preview.version ? ` (current draft v${preview.current_version})` : ""}</p>
              <p><strong>Title:</strong> {preview.title}</p>
              <p><strong>Slug:</strong> {preview.slug}</p>
              <p><strong>URL preview:</strong> <span className="break-all">{preview.url_preview || "—"}</span></p>
              <p><strong>Publisher:</strong> {PUBLISHER_LABELS[preview.website.publisher as PublisherType] ?? (preview.website.publisher || "not configured")}</p>
              <p><strong>Content type:</strong> {preview.content_type}</p>
              {preview.blockers.length > 0 ? (
                <ul className="mt-2 list-disc space-y-1 pl-4 text-rose-700">{preview.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
              ) : (
                <PublishingForm action={publishArticleAction} hidden={{ ...hidden, operation: preview.operation }} submitLabel={preview.operation === "update" ? "Update Publication" : "Publish"} pendingLabel="Queueing…">
                  {preview.high_risk && <label className="mt-2 flex items-start gap-2 text-amber-800"><input type="checkbox" name="ack_high_risk" className="mt-0.5" />HIGH_RISK_REVIEW_REQUIRED: I acknowledge publishing this high-risk content.</label>}
                  <label className="mt-2 flex items-start gap-2"><input type="checkbox" name="confirm" required className="mt-0.5" />I confirm the website, version, title, slug and URL above.</label>
                </PublishingForm>
              )}
            </CardBody>
          </Card>
        )}
        {editable && publication && !activeJob && (
          <Card>
            <CardHeader title="Operate" />
            <CardBody className="space-y-4">
              {publication.status !== "unpublished" && <PublishingForm action={verifyPublicationAction} hidden={hidden} variant="secondary" submitLabel="Verify Again" />}
              {live && (
                <PublishingForm action={unpublishArticleAction} hidden={hidden} variant="danger" submitLabel="Unpublish">
                  <label className="flex items-start gap-2 text-xs text-slate-700"><input type="checkbox" name="confirm" required className="mt-0.5" />Remove public visibility (content is kept, not deleted).</label>
                </PublishingForm>
              )}
              {live && candidates.filter((c) => c.hash !== publication.version_hash).length > 0 && (
                <PublishingForm action={rollbackPublicationAction} hidden={hidden} variant="secondary" submitLabel="Rollback">
                  <label className="flex flex-col gap-1 text-xs text-slate-700">Previously published version
                    <select name="eventId" className="rounded border border-slate-300 px-2 py-1 text-sm" required>
                      {candidates.filter((c) => c.hash !== publication.version_hash).map((c) => <option key={c.event} value={c.event}>v{c.version} · {c.title.slice(0, 50)} · {formatDateTime(c.at)}</option>)}
                    </select>
                  </label>
                  <label className="mt-2 flex items-start gap-2 text-xs text-slate-700"><input type="checkbox" name="confirm" required className="mt-0.5" />Publish this earlier version (newer versions are kept).</label>
                </PublishingForm>
              )}
            </CardBody>
          </Card>
        )}
        {!canPublish && !publication && <Card><CardBody><p className="text-sm text-slate-500">Publishing becomes available after human approval (status: {status}).</p></CardBody></Card>}
      </div>
    </div>
  );
}
