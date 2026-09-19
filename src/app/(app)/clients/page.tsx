import Link from "next/link";
import { requireUser } from "@/lib/pocketbase/auth";
import { listClients } from "@/lib/pocketbase/clients";
import { Card, Badge, statusTone, EmptyState, PageHeader, Button } from "@/components/ui";
import { formatRelative } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const { pb } = await requireUser();
  const clients = await listClients(pb);

  return (
    <div>
      <PageHeader
        title="Clients"
        description="Manage the businesses you provide SEO services to."
        action={
          <Link href="/clients/new">
            <Button>+ Add Client</Button>
          </Link>
        }
      />

      {clients.length === 0 ? (
        <EmptyState
          title="No clients yet"
          description="Create your first client to start building their SEO presence."
          action={
            <Link href="/clients/new">
              <Button>+ Add Client</Button>
            </Link>
          }
        />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Business</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Industry</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Location</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Added</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {clients.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3">
                      <Link href={`/clients/${c.id}`} className="text-sm font-medium text-slate-900 hover:text-sky-600">
                        {c.business_name}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-sm text-slate-600">{c.industry || "—"}</td>
                    <td className="px-5 py-3 text-sm text-slate-600">{c.primary_location || c.country || "—"}</td>
                    <td className="px-5 py-3 text-sm text-slate-500">{formatRelative(c.created_at ?? c.created)}</td>
                    <td className="px-5 py-3">
                      <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
