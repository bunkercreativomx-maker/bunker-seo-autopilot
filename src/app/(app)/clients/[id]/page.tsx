import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/pocketbase/auth";
import { getClient } from "@/lib/pocketbase/clients";
import { listWebsitesByClient } from "@/lib/pocketbase/websites";
import { listActivity } from "@/lib/pocketbase/activity-read";
import { Card, CardHeader, CardBody, Badge, statusTone, EmptyState, PageHeader, Button } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { archiveClientAction } from "@/app/actions/clients";
import { getClientOverview } from "@/lib/pocketbase/analytics";
import { fmtInt, fmtPct, fmtPos } from "@/lib/analytics/format";

export const dynamic = "force-dynamic";

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { pb, user } = await requireUser();
  const client = await getClient(pb, id);
  if (!client) notFound();

  const [websites, activity] = await Promise.all([
    listWebsitesByClient(pb, id),
    listActivity(pb, 10),
  ]);

  const gsc = await getClientOverview(pb, id, "28d");
  const clientActivity = activity.filter((a) => a.client === id);

  const info: Array<[string, string]> = [
    ["Industry", client.industry ?? "—"],
    ["Primary Language", client.primary_language ?? "—"],
    ["Secondary Languages", client.secondary_languages ?? "—"],
    ["Country", client.country ?? "—"],
    ["Primary Location", client.primary_location ?? "—"],
    ["Service Areas", client.service_areas ?? "—"],
    ["Target Audience", client.target_audience ?? "—"],
    ["Brand Voice", client.brand_voice ?? "—"],
    ["Services", client.services ?? "—"],
    ["Products", client.products ?? "—"],
    ["Unique Selling Proposition", client.unique_selling_proposition ?? "—"],
    ["Primary CTA", client.primary_cta ?? "—"],
    ["Phone", client.phone ?? "—"],
    ["Email", client.email ?? "—"],
  ];

  return (
    <div>
      <PageHeader
        title={client.business_name}
        description={client.description || "No description provided."}
        action={
          <div className="flex items-center gap-2">
            <Link href={`/clients/${client.id}/content`}>
              <Button variant="secondary">Content</Button>
            </Link>
            <Link href={`/clients/${client.id}/edit`}>
              <Button variant="secondary">Edit Client</Button>
            </Link>
            <Link href={`/clients/${client.id}/websites/new`}>
              <Button>+ Add Website</Button>
            </Link>
          </div>
        }
      />

      <div className="mb-4 flex items-center gap-2">
        <Badge tone={statusTone(client.status)}>{client.status}</Badge>
        <span className="text-xs text-slate-500">Added {formatDate(client.created_at ?? client.created)}</span>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Business information */}
        <Card className="lg:col-span-2">
          <CardHeader title="Business Information" />
          <CardBody>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
              {info.map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
                  <dd className="mt-0.5 text-sm text-slate-800">{value}</dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>

        {/* Websites */}
        <Card>
          <CardHeader
            title="Websites"
            action={
              <Link href={`/clients/${client.id}/websites/new`} className="text-xs font-medium text-sky-600 hover:text-sky-500">
                + Add
              </Link>
            }
          />
          <CardBody className="p-0">
            {websites.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  title="No websites"
                  description="Add a website to this client."
                  action={
                    <Link href={`/clients/${client.id}/websites/new`}>
                      <Button>Add Website</Button>
                    </Link>
                  }
                />
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {websites.map((w) => (
                  <li key={w.id}>
                    <Link href={`/websites/${w.id}`} className="flex items-center justify-between px-5 py-3 hover:bg-slate-50">
                      <div>
                        <div className="text-sm font-medium text-slate-900">{w.name}</div>
                        <div className="text-xs text-slate-500">{w.domain}</div>
                      </div>
                      <Badge tone={statusTone(w.status)}>{w.status}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Search Console analytics (Phase 6) */}
      {gsc && gsc.sites.length > 0 && (
        <div className="mt-6">
          <Card>
            <CardHeader title="Search Console — last 28 finalized days" subtitle="Source: Google Search Console. Totals are summed; CTR = total clicks / total impressions; position is shown per website." />
            <CardBody className="space-y-3 text-sm">
              <p>
                <b>{fmtInt(gsc.aggregate.clicks)}</b> clicks · <b>{fmtInt(gsc.aggregate.impressions)}</b> impressions · CTR <b>{fmtPct(gsc.aggregate.ctr, 2)}</b>
                {gsc.aggregate.weightedPosition !== null && <span className="text-slate-500"> · impression-weighted avg. position {fmtPos(gsc.aggregate.weightedPosition)}</span>}
              </p>
              <ul className="divide-y divide-slate-100">
                {gsc.sites.map((s) => (
                  <li key={s.website.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <Link className="text-sky-700" href={`/websites/${s.website.id}/analytics`}>{s.website.name}</Link>
                    {!s.connected ? <span className="text-xs text-slate-400">Search Console not connected</span>
                      : !s.totals ? <span className="text-xs text-slate-400">No data yet</span>
                      : <span className="text-xs text-slate-600">{fmtInt(s.totals.clicks)} clicks · {fmtInt(s.totals.impressions)} impressions · CTR {fmtPct(s.totals.ctr, 2)} · avg. position {fmtPos(s.totals.position)}</span>}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>
      )}

      {/* Activity */}
      <div className="mt-6">
        <Card>
          <CardHeader title="Activity" />
          <CardBody className="p-0">
            {clientActivity.length === 0 ? (
              <div className="p-5">
                <EmptyState title="No activity yet" description="Actions on this client will appear here." />
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {clientActivity.map((a) => (
                  <li key={a.id} className="flex items-center justify-between px-5 py-3">
                    <div className="text-sm text-slate-800">{a.action.replace(/_/g, " ").toLowerCase()}</div>
                    <div className="text-xs text-slate-500">{formatDate(a.created_at ?? a.created)}</div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Archive */}
      {user.role !== "viewer" && (
        <div className="mt-6 flex items-center justify-between rounded-xl border border-rose-200 bg-rose-50 px-5 py-4">
          <div>
            <div className="text-sm font-medium text-rose-800">Archive this client</div>
            <div className="text-xs text-rose-600">Archived clients are hidden from active lists but kept for reference.</div>
          </div>
          <form action={archiveClientAction}>
            <input type="hidden" name="id" value={client.id} />
            <Button variant="danger" type="submit">
              Archive
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
