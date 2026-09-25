import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser, isAdmin } from "@/lib/pocketbase/auth";
import { getWebsite } from "@/lib/pocketbase/websites";
import { getConnectionInfo, listPropertyOptions, listSyncJobs, storageCounts } from "@/lib/pocketbase/analytics";
import { Badge, Card, CardBody, CardHeader, EmptyState, Input } from "@/components/ui";
import { AnalyticsForm, SyncProgress } from "@/components/analytics/analytics-form";
import { connectGoogleAction, disconnectAction, refreshPropertiesAction, selectPropertyAction, syncNowAction } from "@/app/actions/analytics";
import { formatDateTime } from "@/lib/format";
import { fmtInt } from "@/lib/analytics/format";

export const dynamic = "force-dynamic";

const matchTone = (m: string) => (m === "matched" ? "green" : m === "possible_match" ? "amber" : "red") as "green" | "amber" | "red";
const matchLabel = (m: string) => (m === "matched" ? "MATCHED" : m === "possible_match" ? "POSSIBLE MATCH" : "MISMATCH");
const statusTone = (s: string) => (s === "connected" || s === "active" ? "green" : s === "disconnected" ? "slate" : "red") as "green" | "slate" | "red";

export default async function SearchConsolePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { pb, user } = await requireUser();
  const website = await getWebsite(pb, id);
  if (!website) notFound();
  const info = await getConnectionInfo(pb, id);
  if (!info) return <EmptyState title="Search Console unavailable" description="The analytics service could not be reached." />;
  const activeConnectionId = sp.connection || info.connections.find((c) => c.status === "connected")?.id || info.connections[0]?.id;
  const [properties, jobs, counts] = await Promise.all([
    listPropertyOptions(pb, id, activeConnectionId),
    listSyncJobs(pb, `website = "${id}"`, 5),
    storageCounts(pb, id),
  ]);
  const running = jobs.find((j) => j.status === "queued" || j.status === "running");
  const selected = info.selected;
  const canManage = info.canManage;
  const canSync = user.role !== "viewer" && user.role !== "client";

  return (
    <div className="space-y-6">
      {sp.connected && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">Google account {sp.connected === "reconnected" ? "reconnected" : "connected"}. Select the Search Console property for this website below.</div>}

      <Card>
        <CardHeader title="Search Console connection" subtitle="Read-only access. Phase 6 measures and recommends — it never edits, publishes or requests indexing." />
        <CardBody className="space-y-4">
          <div className="grid gap-3 text-sm md:grid-cols-3">
            <div><p className="text-xs text-slate-500">Connected Account</p><p className="font-medium">{selected?.google_account_email || "—"}</p></div>
            <div><p className="text-xs text-slate-500">Property</p><p className="font-mono text-xs">{selected?.site_url || "—"}</p></div>
            <div><p className="text-xs text-slate-500">Permission</p><p>{selected?.permission_level || "—"}</p></div>
            <div><p className="text-xs text-slate-500">Last Sync</p><p>{selected?.last_sync_at ? `${formatDateTime(selected.last_sync_at)} · ${selected.last_sync_status}` : "—"}</p></div>
            <div><p className="text-xs text-slate-500">Latest Data Date</p><p>{selected?.latest_final_date || "—"} {selected?.latest_final_date && <span className="text-xs text-slate-400">(finalized, Search Console / PT)</span>}</p></div>
            <div><p className="text-xs text-slate-500">Connection Status</p><p>{selected ? <Badge tone={statusTone(selected.connection_status)}>{selected.connection_status}</Badge> : <Badge>not connected</Badge>} {selected && selected.status === "access_lost" && <Badge tone="red">access lost</Badge>}</p></div>
          </div>
          <p className="text-xs text-slate-500">Scopes: Search Console — Read Only{info.oauth.scopes.includes("email") ? " · account email (openid/email)" : ""}. Tokens are stored encrypted server-side and are never shown.</p>
          {info.oauth.testingMode && <p className="rounded bg-amber-50 p-2 text-xs text-amber-800">The Google OAuth app is in <b>Testing</b> mode: only Google accounts added as test users can connect, and refresh tokens expire after 7 days. Not yet available to external clients until Google verification is completed.</p>}
          {!info.oauth.configured && <p className="rounded bg-rose-50 p-2 text-xs text-rose-700">Google OAuth is not configured on the server yet.</p>}

          {canManage ? (
            <div className="flex flex-wrap gap-3">
              <AnalyticsForm action={connectGoogleAction} hidden={{ websiteId: id }} submitLabel={info.connections.length ? "Connect another Google account" : "Connect Google"} pendingLabel="Redirecting to Google…" variant={info.connections.length ? "secondary" : "primary"} />
              {info.connections.filter((c) => c.status !== "connected").map((c) => (
                <AnalyticsForm key={c.id} action={connectGoogleAction} hidden={{ websiteId: id, connectionId: c.id }} submitLabel={`Reconnect ${c.google_account_email}`} pendingLabel="Redirecting…" variant="secondary" />
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-500">Only admins can connect, reconnect, change property or disconnect Search Console.</p>
          )}
        </CardBody>
      </Card>

      {info.connections.length > 0 && (
        <Card>
          <CardHeader title="Google accounts in this organization" subtitle="Each website can use a different Google account." />
          <CardBody className="p-0">
            <ul className="divide-y divide-slate-100 text-sm">
              {info.connections.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div>
                    <Link href={`?connection=${c.id}`} className={c.id === activeConnectionId ? "font-semibold" : "text-sky-700"}>{c.google_account_email || "(email not shared)"}</Link>
                    <span className="ml-2"><Badge tone={statusTone(c.status)}>{c.status}</Badge></span>
                    {c.last_error && <p className="text-xs text-rose-600">{c.last_error}</p>}
                  </div>
                  {canManage && c.status === "connected" && (
                    <div className="flex flex-wrap items-center gap-2">
                      <AnalyticsForm action={refreshPropertiesAction} hidden={{ websiteId: id, connectionId: c.id }} submitLabel="Refresh properties" variant="ghost" />
                      <AnalyticsForm action={disconnectAction} hidden={{ websiteId: id, connectionId: c.id }} submitLabel="Disconnect" variant="danger" inline>
                        <label className="flex items-center gap-1 text-xs text-slate-600"><input type="checkbox" name="confirm" /> confirm (historical data is kept)</label>
                      </AnalyticsForm>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {activeConnectionId && (
        <Card>
          <CardHeader title={selected ? "Change property" : "Select Search Console property"} subtitle={`Website domain: ${website.domain}. site_url is shown exactly as Google returns it.`} />
          <CardBody className="p-0">
            {properties.length === 0 ? (
              <div className="p-5 text-sm text-slate-500">No properties listed for this Google account. Use “Refresh properties”.</div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {properties.map((p) => (
                  <li key={p.id} className="px-5 py-3">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-mono text-xs">{p.site_url}</span>
                      <Badge>{p.property_type === "domain" ? "Domain" : "URL prefix"}</Badge>
                      <Badge>{p.permission_level}</Badge>
                      <Badge tone={matchTone(p.match_status)}>{matchLabel(p.match_status)}</Badge>
                      {p.status === "access_lost" && <Badge tone="red">access lost</Badge>}
                      {p.mapped_to_this_website && <Badge tone="blue">selected for this website</Badge>}
                      {p.website && !p.mapped_to_this_website && <Badge tone="amber">mapped to another website</Badge>}
                    </div>
                    {canManage && !p.mapped_to_this_website && p.match_status !== "mismatch" && p.status !== "access_lost" && !p.website && (
                      <AnalyticsForm action={selectPropertyAction} hidden={{ websiteId: id, propertyId: p.id }} submitLabel="Map to this website" variant="secondary" inline className="mt-2">
                        <label className="flex items-center gap-1 text-xs text-slate-600"><input type="checkbox" name="confirm" /> I confirm this property belongs to {website.domain}</label>
                        {p.match_status === "possible_match" && <Input name="confirmDomain" placeholder={`type ${website.domain}`} className="w-48" />}
                        <label className="flex items-center gap-1 text-xs text-slate-600"><input type="checkbox" name="initialSync" defaultChecked /> initial sync (90 days)</label>
                      </AnalyticsForm>
                    )}
                    {p.match_status === "mismatch" && <p className="mt-1 text-xs text-slate-400">Does not match {website.domain}; cannot be mapped to this website.</p>}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      {selected && (
        <Card>
          <CardHeader title="Sync" subtitle="Finalized data only (dataState=final). Daily automatic sync runs from the analytics worker." action={<Link href={`/websites/${id}/analytics/sync`} className="text-xs text-sky-600">Sync history</Link>} />
          <CardBody>
            {running && <SyncProgress jobId={running.id} />}
            {canSync && selected.connection_status === "connected" && selected.status === "active" && (
              <AnalyticsForm action={syncNowAction} hidden={{ websiteId: id }} submitLabel="Sync Now" inline>
                <select name="range" defaultValue="28d" className="rounded-lg border border-slate-300 px-2 py-2 text-sm">
                  <option value="28d">Last 28 days</option>
                  <option value="90d">Last 90 days</option>
                  {isAdmin(user.role) && <option value="6m">Backfill 6 months (admin)</option>}
                  {isAdmin(user.role) && <option value="custom">Custom range (admin)</option>}
                </select>
                {isAdmin(user.role) && <><Input type="date" name="startDate" className="w-40" /><Input type="date" name="endDate" className="w-40" /></>}
              </AnalyticsForm>
            )}
            <p className="mt-4 text-xs text-slate-500">Stored rows — site/day {fmtInt(counts.site)} · page/day {fmtInt(counts.page)} · query/day {fmtInt(counts.query)} · query+page/day {fmtInt(counts.queryPage)} · opportunities {fmtInt(counts.opps)}</p>
          </CardBody>
        </Card>
      )}

      {info.oauth.redirectUri && isAdmin(user.role) && (
        <p className="text-xs text-slate-400">OAuth redirect URI: <code>{info.oauth.redirectUri}</code></p>
      )}
    </div>
  );
}
