import Link from "next/link";
import { requireUser } from "@/lib/pocketbase/auth";
import { listClients } from "@/lib/pocketbase/clients";
import { listWebsites } from "@/lib/pocketbase/websites";
import { listActivity } from "@/lib/pocketbase/activity-read";
import { Card, CardHeader, CardBody, Badge, statusTone, EmptyState, PageHeader, Button } from "@/components/ui";
import { formatDate, formatRelative } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { pb, user } = await requireUser();
  const [clients, websites, activity] = await Promise.all([
    listClients(pb),
    listWebsites(pb),
    listActivity(pb, 8),
  ]);

  const activeWebsites = websites.filter((w) => w.status === "active").length;
  const recentClients = clients.slice(0, 5);
  const recentWebsites = websites.slice(0, 5);

  return (
    <div>
      <PageHeader
        title={`Welcome back${user.name ? `, ${user.name.split(" ")[0]}` : ""}`}
        description="Here's what's happening across your organization."
        action={
          <Link href="/clients/new">
            <Button>+ Add Client</Button>
          </Link>
        }
      />

      {/* KPI cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardBody>
            <div className="text-sm font-medium text-slate-500">Total Clients</div>
            <div className="mt-1 text-3xl font-semibold text-slate-900">{clients.length}</div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-sm font-medium text-slate-500">Total Websites</div>
            <div className="mt-1 text-3xl font-semibold text-slate-900">{websites.length}</div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-sm font-medium text-slate-500">Active Websites</div>
            <div className="mt-1 text-3xl font-semibold text-emerald-600">{activeWebsites}</div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-sm font-medium text-slate-500">Recent Activity</div>
            <div className="mt-1 text-3xl font-semibold text-slate-900">{activity.length}</div>
          </CardBody>
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Recent clients */}
        <Card>
          <CardHeader
            title="Recent Clients"
            action={
              <Link href="/clients" className="text-xs font-medium text-sky-600 hover:text-sky-500">
                View all
              </Link>
            }
          />
          <CardBody className="p-0">
            {recentClients.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  title="No clients yet"
                  description="Create your first client to start building their SEO presence."
                  action={
                    <Link href="/clients/new">
                      <Button>Add Client</Button>
                    </Link>
                  }
                />
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {recentClients.map((c) => (
                  <li key={c.id}>
                    <Link href={`/clients/${c.id}`} className="flex items-center justify-between px-5 py-3 hover:bg-slate-50">
                      <div>
                        <div className="text-sm font-medium text-slate-900">{c.business_name}</div>
                        <div className="text-xs text-slate-500">
                          {c.industry || "No industry"} · {formatRelative(c.created_at ?? c.created)}
                        </div>
                      </div>
                      <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* Recent websites */}
        <Card>
          <CardHeader
            title="Recent Websites"
            action={
              <Link href="/websites" className="text-xs font-medium text-sky-600 hover:text-sky-500">
                View all
              </Link>
            }
          />
          <CardBody className="p-0">
            {recentWebsites.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  title="No websites yet"
                  description="Add a website to a client to start tracking their SEO."
                  action={
                    <Link href="/websites/new">
                      <Button>Add Website</Button>
                    </Link>
                  }
                />
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {recentWebsites.map((w) => (
                  <li key={w.id}>
                    <Link href={`/websites/${w.id}`} className="flex items-center justify-between px-5 py-3 hover:bg-slate-50">
                      <div>
                        <div className="text-sm font-medium text-slate-900">{w.name}</div>
                        <div className="text-xs text-slate-500">
                          {w.domain} · {w.expand?.client?.business_name ?? "—"}
                        </div>
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

      {/* Activity */}
      <div className="mt-6">
        <Card>
          <CardHeader
            title="Activity"
            action={
              <Link href="/activity" className="text-xs font-medium text-sky-600 hover:text-sky-500">
                View all
              </Link>
            }
          />
          <CardBody className="p-0">
            {activity.length === 0 ? (
              <div className="p-5">
                <EmptyState title="No activity yet" description="Actions you take will appear here." />
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {activity.map((a) => (
                  <li key={a.id} className="flex items-center justify-between px-5 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </div>
                      <div>
                        <div className="text-sm text-slate-800">{a.action.replace(/_/g, " ").toLowerCase()}</div>
                        <div className="text-xs text-slate-500">{formatDate(a.created_at ?? a.created)}</div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
