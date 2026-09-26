import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser, isAdmin } from "@/lib/pocketbase/auth";
import { getIntegration, getPublishingWebsite, listPublishJobs } from "@/lib/pocketbase/publishing";
import { Badge, Card, CardBody, CardHeader, Field, Input, Select } from "@/components/ui";
import { PublishingForm } from "@/components/publishing/publishing-form";
import { savePublishingConfigAction, saveSecretAction, testConnectionAction } from "@/app/actions/publishing";
import { CONNECTION_LABELS, PUBLISHER_LABELS, connectionTone, type ConnectionStatus, type PublisherType } from "@/lib/publishing/types";
import { formatDateTime } from "@/lib/format";
import { ConnectWebsite } from "@/components/publishing/connect-website";
import { connectSnippets } from "@/lib/connect";

export const dynamic = "force-dynamic";

export default async function WebsitePublishingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { pb, user } = await requireUser();
  const w = await getPublishingWebsite(pb, id);
  if (!w) notFound();
  const integration = await getIntegration(pb, w.id);
  const jobs = await listPublishJobs(pb, `website = "${w.id}"`, 15);
  const admin = isAdmin(user.role);
  const cfg = (w.publishing_configuration ?? {}) as Record<string, unknown>;
  const conn = (w.connection_status || "not_configured") as ConnectionStatus;
  const lastPublication = jobs.find((j) => j.status === "published");
  const hidden = { websiteId: w.id };

  const snippets = connectSnippets(w.id);
  const hubConnected = w.publisher_type === "pocketbase_cms" && w.publishing_environment === "production" && w.connection_status === "connected";
  const otherPublisher = Boolean(w.publisher_type && w.publisher_type !== "pocketbase_cms");

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Connect website" subtitle={`Show your posts at ${w.domain}/blog — one time, about 5 minutes.`} />
        <CardBody>
          {otherPublisher ? (
            <p className="text-sm text-slate-600">This website publishes through <strong>{PUBLISHER_LABELS[w.publisher_type as PublisherType] ?? w.publisher_type}</strong> ({CONNECTION_LABELS[conn] ?? conn}). Manage it in Advanced settings below.</p>
          ) : (
            <ConnectWebsite websiteId={w.id} domain={String(w.domain || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "")} snippet={snippets.file} rewriteLines={snippets.lines}
              connected={hubConnected} lastError={w.connection_status === "invalid_response" ? w.last_connection_error : undefined} admin={admin} />
          )}
        </CardBody>
      </Card>

      <details className="group">
        <summary className="cursor-pointer select-none text-sm font-medium text-slate-500 hover:text-slate-800">Advanced settings (WordPress, API, webhook, history)</summary>
        <div className="mt-4 space-y-6">
      <div className="grid gap-4 md:grid-cols-4">
        <Card><CardBody><p className="text-xs text-slate-500">Publisher status</p><div className="mt-1"><Badge tone={connectionTone(conn)}>{CONNECTION_LABELS[conn] ?? conn}</Badge></div></CardBody></Card>
        <Card><CardBody><p className="text-xs text-slate-500">Publishing</p><p className="mt-1 text-sm font-semibold">{w.publishing_enabled ? "Enabled" : "Disabled"} · {w.publishing_mode || "manual"}</p></CardBody></Card>
        <Card><CardBody><p className="text-xs text-slate-500">Last connection test</p><p className="mt-1 text-sm">{w.last_connection_test ? formatDateTime(w.last_connection_test) : "Never"}</p>{w.last_connection_error ? <p className="text-xs text-rose-600">{w.last_connection_error}</p> : null}</CardBody></Card>
        <Card><CardBody><p className="text-xs text-slate-500">Last publication</p><p className="mt-1 text-sm">{lastPublication ? formatDateTime(lastPublication.completed_at) : "None"}</p></CardBody></Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Publishing configuration" subtitle="Disabled until configured. Mode is manual (human confirmation per publication). Autopilot is not available in Phase 5." />
          <CardBody>
            {!admin ? <p className="text-sm text-slate-500">Only organization admins can change publishing configuration.</p> : (
              <PublishingForm action={savePublishingConfigAction} hidden={hidden} submitLabel="Save configuration">
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Publisher">
                    <Select name="publisherType" defaultValue={w.publisher_type || ""} required>
                      <option value="">— choose —</option>
                      {(Object.keys(PUBLISHER_LABELS) as PublisherType[]).map((k) => <option key={k} value={k}>{PUBLISHER_LABELS[k]}</option>)}
                    </Select>
                  </Field>
                  <Field label="Environment">
                    <Select name="environment" defaultValue={w.publishing_environment || "staging"}>
                      <option value="staging">Staging</option>
                      <option value="production">Production</option>
                    </Select>
                  </Field>
                  <Field label="Mode">
                    <Select name="publishingMode" defaultValue={w.publishing_mode || "manual"}>
                      <option value="manual">Manual</option>
                      <option value="approval">Approval</option>
                    </Select>
                  </Field>
                  <Field label="Public base URL (https://…)"><Input name="baseUrl" defaultValue={w.base_url ?? ""} placeholder="https://staging.example.com" /></Field>
                  <Field label="Blog path"><Input name="blogPath" defaultValue={w.blog_path || "/blog"} /></Field>
                  <Field label="Allowed domains (comma-separated)"><Input name="allowedDomains" defaultValue={(w.allowed_domains ?? []).join(", ")} placeholder="staging.example.com" /></Field>
                  <Field label="API endpoint (Next.js API / webhook / WordPress)"><Input name="apiEndpoint" defaultValue={w.api_endpoint ?? ""} /></Field>
                  <Field label="Revalidate URL (PocketBase CMS mode)"><Input name="revalidateUrl" defaultValue={String(cfg.revalidate_url ?? "")} /></Field>
                  <Field label="Sitemap URL"><Input name="sitemapUrl" defaultValue={String(cfg.sitemap_url ?? "")} /></Field>
                  <Field label="WordPress username (WordPress only)"><Input name="username" defaultValue={integration?.username ?? ""} autoComplete="off" /></Field>
                  <Field label="WordPress post status"><Select name="wordpressStatus" defaultValue={String(cfg.wordpress_status ?? "publish")}><option value="publish">publish</option><option value="draft">draft</option></Select></Field>
                  <Field label="WordPress SEO plugin"><Select name="wordpressSeoPlugin" defaultValue={String(cfg.wordpress_seo_plugin ?? "none")}><option value="none">none</option><option value="yoast">Yoast (meta via plugin fields)</option><option value="rankmath">Rank Math</option></Select></Field>
                </div>
                <div className="mt-3 flex flex-wrap gap-5 text-sm text-slate-700">
                  <label className="flex items-center gap-2"><input type="checkbox" name="enabled" defaultChecked={Boolean(w.publishing_enabled)} />Publishing enabled</label>
                  <label className="flex items-center gap-2"><input type="checkbox" name="autoRevalidate" defaultChecked={w.auto_revalidate !== false} />Revalidate after publish/update/unpublish</label>
                  <label className="flex items-center gap-2"><input type="checkbox" name="verifySitemap" defaultChecked={Boolean(cfg.verify_sitemap)} />Verify sitemap</label>
                </div>
              </PublishingForm>
            )}
          </CardBody>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Connection" subtitle="Test Connection never publishes content." />
            <CardBody>
              <PublishingForm action={testConnectionAction} hidden={hidden} variant="secondary" submitLabel="Test Connection" pendingLabel="Queueing…" />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Publisher secret" subtitle="Stored encrypted server-side; never returned to the browser." />
            <CardBody className="space-y-3 text-sm">
              <p>Status: {integration?.secret_last4 ? <><Badge tone="green">Set</Badge> <span className="text-xs text-slate-500">…{integration.secret_last4} · {formatDateTime(integration.secret_set_at)}</span></> : <Badge tone="slate">Not set</Badge>}</p>
              {integration?.previous_secret_valid_until && <p className="text-xs text-amber-700">Previous secret accepted until {formatDateTime(integration.previous_secret_valid_until)} (rotation grace).</p>}
              {admin && (
                <>
                  <PublishingForm action={saveSecretAction} hidden={{ ...hidden, generate: "1" }} variant="secondary" submitLabel={integration?.secret_last4 ? "Rotate (generate new)" : "Generate secret"}>
                    <Field label="Grace period for previous secret (hours, 0–168)"><Input name="graceHours" type="number" min={0} max={168} defaultValue={integration?.secret_last4 ? 24 : 0} /></Field>
                  </PublishingForm>
                  <PublishingForm action={saveSecretAction} hidden={hidden} variant="ghost" submitLabel="Save provided secret / app password">
                    <Field label="Secret (WordPress application password or shared secret)"><Input name="secret" type="password" autoComplete="new-password" minLength={16} maxLength={512} /></Field>
                  </PublishingForm>
                </>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader title="Publishing queue" subtitle="Latest jobs for this website." />
        <CardBody className="overflow-x-auto px-0">
          {jobs.length === 0 ? <p className="px-5 text-sm text-slate-500">No publishing jobs yet.</p> : (
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50"><tr>{["Operation", "Article", "Version", "Status", "Attempt", "Requested", "Result"].map((h) => <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase text-slate-500">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-slate-100">
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="px-4 py-2">{j.operation}</td>
                    <td className="px-4 py-2">{j.article ? <Link className="text-sky-700" href={`/articles/${j.article}?tab=publishing`}>{j.expand?.article?.title || j.article}</Link> : "—"}</td>
                    <td className="px-4 py-2">{j.article_version ? `v${j.article_version}` : "—"}</td>
                    <td className="px-4 py-2"><Badge tone={j.status === "published" || j.status === "unpublished" ? "green" : j.status === "failed" ? "red" : j.status === "verification_required" ? "amber" : "blue"}>{j.status}</Badge></td>
                    <td className="px-4 py-2 text-xs">{j.attempt ?? 0}/{j.max_attempts ?? 3}</td>
                    <td className="px-4 py-2 text-xs">{formatDateTime(j.requested_at)}</td>
                    <td className="max-w-md px-4 py-2 text-xs">{j.error_code ? <span className="text-rose-600">{j.error_code}: {j.error_message}</span> : j.public_url ? <a className="break-all text-sky-700" href={j.public_url} target="_blank" rel="noopener noreferrer">{j.public_url}</a> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
        </div>
      </details>
    </div>
  );
}
