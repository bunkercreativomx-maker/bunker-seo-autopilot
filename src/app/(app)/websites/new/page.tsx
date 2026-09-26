import { requireUser } from "@/lib/pocketbase/auth";
import { listClients } from "@/lib/pocketbase/clients";
import { WebsiteForm } from "@/components/website-form";
import { QuickAddWebsite } from "@/components/quick-add-website";

export const dynamic = "force-dynamic";

export default async function NewWebsitePage({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  const { pb } = await requireUser();
  const clients = await listClients(pb);
  const { client } = await searchParams;

  return (
    <div className="mx-auto max-w-lg space-y-6 py-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Add a website</h1>
        <p className="mt-1 text-sm text-slate-500">Paste the URL. We do the rest in about 3 minutes.</p>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <QuickAddWebsite clients={clients.map((c) => ({ id: c.id, business_name: c.business_name }))} defaultClientId={client} />
      </div>
      <details className="rounded-2xl border border-slate-200 bg-white px-5 py-3">
        <summary className="cursor-pointer text-sm font-medium text-slate-500">Advanced: enter details by hand</summary>
        <div className="mt-4"><WebsiteForm clients={clients} defaultClientId={client} /></div>
      </details>
    </div>
  );
}
