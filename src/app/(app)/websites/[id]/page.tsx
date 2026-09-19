import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/pocketbase/auth";
import { getWebsite } from "@/lib/pocketbase/websites";
import { Card, CardHeader, CardBody, Badge, statusTone, PageHeader, Button } from "@/components/ui";
import { WebsiteTabs } from "@/components/website-tabs";
import { formatDate } from "@/lib/format";
import { archiveWebsiteAction } from "@/app/actions/websites";

export const dynamic = "force-dynamic";

export default async function WebsiteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { pb, user } = await requireUser();
  const website = await getWebsite(pb, id);
  if (!website) notFound();

  const client = website.expand?.client;
  const info: Array<[string, string]> = [
    ["Client", client?.business_name ?? "—"],
    ["Domain", website.domain],
    ["Platform", website.platform],
    ["Primary Language", website.primary_language ?? "—"],
    ["Country", website.country ?? "—"],
    ["Target Locations", website.target_locations ?? "—"],
    ["Sitemap", website.sitemap_url || "—"],
    ["Robots", website.robots_url || "—"],
    ["Blog URL", website.blog_url || "—"],
    ["Status", website.status],
  ];

  const overview = (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title="Website Information" />
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
      <Card>
        <CardHeader title="Details" />
        <CardBody className="space-y-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Added</div>
            <div className="mt-0.5 text-sm text-slate-800">{formatDate(website.created_at ?? website.created)}</div>
          </div>
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Status</div>
            <div className="mt-1">
              <Badge tone={statusTone(website.status)}>{website.status}</Badge>
            </div>
          </div>
          {client && (
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Client</div>
              <Link href={`/clients/${client.id}`} className="mt-0.5 block text-sm font-medium text-sky-600 hover:text-sky-500">
                {client.business_name}
              </Link>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );

  return (
    <div>
      <PageHeader
        title={website.name}
        description={website.domain}
        action={
          <div className="flex items-center gap-2">
            <Link href={`/websites/${website.id}/edit`}>
              <Button variant="secondary">Edit Website</Button>
            </Link>
          </div>
        }
      />

      <WebsiteTabs overview={overview} />

      {user.role !== "viewer" && (
        <div className="mt-4 flex items-center justify-between rounded-xl border border-rose-200 bg-rose-50 px-5 py-4">
          <div>
            <div className="text-sm font-medium text-rose-800">Archive this website</div>
            <div className="text-xs text-rose-600">Archived websites are hidden from active lists but kept for reference.</div>
          </div>
          <form action={archiveWebsiteAction}>
            <input type="hidden" name="id" value={website.id} />
            <Button variant="danger" type="submit">
              Archive
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
