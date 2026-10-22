import Link from "next/link";
import { requireUser } from "@/lib/pocketbase/auth";
import { listWebsites } from "@/lib/pocketbase/websites";
import { Card, Badge, statusTone, EmptyState, PageHeader, Button } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function WebsitesPage() {
  const { pb } = await requireUser();
  const websites = await listWebsites(pb);

  return (
    <div>
      <PageHeader
        title="Websites"
        description="All websites across your clients."
        action={
          <Link href="/websites/new">
            <Button>+ Add Website</Button>
          </Link>
        }
      />

      {websites.length === 0 ? (
        <EmptyState
          title="No websites yet"
          description="Add a website to a client to start tracking their SEO."
          action={
            <Link href="/websites/new">
              <Button>+ Add Website</Button>
            </Link>
          }
        />
      ) : (
        <>
        {/* Phone: one card per website */}
        <ul className="space-y-2 sm:hidden">
          {websites.map((w) => (
            <li key={w.id}>
              <Link href={`/websites/${w.id}`} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 active:bg-slate-50">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900">{w.name}</p>
                  <p className="truncate text-xs text-slate-500">{w.domain}</p>
                </div>
                <Badge tone={statusTone(w.status)}>{w.status}</Badge>
              </Link>
            </li>
          ))}
        </ul>
        <Card className="hidden sm:block">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Website</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Client</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Domain</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Platform</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Language</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {websites.map((w) => (
                  <tr key={w.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3">
                      <Link href={`/websites/${w.id}`} className="text-sm font-medium text-slate-900 hover:text-sky-600">
                        {w.name}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-sm text-slate-600">{w.expand?.client?.business_name ?? "—"}</td>
                    <td className="px-5 py-3 text-sm text-slate-600">{w.domain}</td>
                    <td className="px-5 py-3">
                      <span className="inline-flex rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                        {w.platform}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-sm text-slate-600">{w.primary_language || "—"}</td>
                    <td className="px-5 py-3">
                      <Badge tone={statusTone(w.status)}>{w.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        </>
      )}
    </div>
  );
}
