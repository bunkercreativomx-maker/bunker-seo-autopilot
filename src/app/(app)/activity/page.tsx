import { requireUser } from "@/lib/pocketbase/auth";
import { listActivity } from "@/lib/pocketbase/activity-read";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  const { pb } = await requireUser();
  const activity = await listActivity(pb, 100);

  return (
    <div>
      <PageHeader title="Activity" description="A chronological log of actions across your organization." />
      {activity.length === 0 ? (
        <EmptyState title="No activity yet" description="Actions you take will appear here." />
      ) : (
        <Card>
          <ul className="divide-y divide-slate-100">
            {activity.map((a) => {
              const actor = a.expand?.user?.name || a.expand?.user?.email || "System";
              const target = a.expand?.client?.business_name || a.expand?.website?.name || "";
              return (
                <li key={a.id} className="flex items-start gap-3 px-5 py-4">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-slate-800">
                      <span className="font-medium capitalize">{a.action.replace(/_/g, " ").toLowerCase()}</span>
                      {target && <span className="text-slate-500"> · {target}</span>}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {actor} · {formatDateTime(a.created_at ?? a.created)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
