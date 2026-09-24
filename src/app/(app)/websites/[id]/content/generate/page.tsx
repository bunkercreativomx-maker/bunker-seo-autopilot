import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser, canWrite } from "@/lib/pocketbase/auth";
import { adminAuth, createBaseClient } from "@/lib/pocketbase/client";
import { prepareGeneration, ContentError } from "@/lib/content/core";
import { GenerateContentForm } from "@/components/content/generate-form";
import { Card, CardBody, CardHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function GenerateContentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ source?: string; sid?: string }> }) {
  const { id } = await params;
  const { source, sid } = await searchParams;
  const { user } = await requireUser();
  if (!canWrite(user.role)) notFound();
  if ((source !== "opportunity" && source !== "plan_item") || !sid || !/^[a-z0-9]{15}$/.test(sid)) notFound();
  const admin = createBaseClient();
  admin.autoCancellation(false);
  await adminAuth(admin);
  let preview;
  try {
    preview = await prepareGeneration(admin, { id: user.id, organization: user.organization ?? "", role: user.role }, id, { kind: source, id: sid });
  } catch (error) {
    const message = error instanceof ContentError ? error.message : "Could not prepare generation.";
    return <div className="mt-6"><Card><CardBody><p className="text-sm text-rose-700">{message}</p><Link href={`/websites/${id}/strategy`} className="mt-3 inline-block text-sm text-sky-700">← Back to strategy</Link></CardBody></Card></div>;
  }
  const bc = preview.business_context;
  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <Card>
          <CardHeader title="Generate Content" subtitle={`${preview.website.name} · ${preview.source.kind === "opportunity" ? "Approved opportunity" : "Approved plan item"}`} />
          <CardBody>
            {preview.existing_article ? (
              <div className="space-y-3 text-sm">
                <p>Content already exists for this source (status: <strong>{preview.existing_article.status}</strong>). Repeated generation is blocked to avoid duplicate articles.</p>
                <Link href={`/articles/${preview.existing_article.id}`} className="inline-block rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-medium text-white">Open Draft</Link>
              </div>
            ) : (
              <GenerateContentForm websiteId={preview.website.id} sourceKind={preview.source.kind} sourceId={preview.source.id} defaults={preview.defaults} />
            )}
            {preview.existing_page_url && <p className="mt-4 text-xs text-slate-500">Existing page: {preview.existing_page_url} — it will NOT be modified; an Existing vs Proposed version is produced.</p>}
          </CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader title="Business Context" subtitle="What the writer may state as fact" />
        <CardBody className="space-y-3 text-sm">
          <p><span className="text-slate-500">Business:</span> {bc.business_name}</p>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Verified facts ({bc.verified_facts.length})</p>
            {bc.verified_facts.length === 0 ? <p className="text-xs text-amber-700">No verified business facts. The writer will avoid business-specific claims (prices, warranties, financing, credentials…).</p> : (
              <ul className="mt-1 space-y-1 text-xs">{bc.verified_facts.map((f, i) => <li key={i}><strong>{f.label}:</strong> {f.value}</li>)}</ul>
            )}
          </div>
          <p className="text-xs text-slate-500">{bc.unverified_fact_count} unverified / AI-inferred fact(s) will be treated as unverified and never asserted.</p>
          {bc.declared_services && <p className="text-xs"><span className="text-slate-500">Declared services:</span> {bc.declared_services}</p>}
          {bc.declared_locations && <p className="text-xs"><span className="text-slate-500">Locations:</span> {bc.declared_locations}</p>}
          <p className="text-xs"><span className="text-slate-500">Brand voice:</span> {bc.brand_voice || "Not provided — professional, clear, natural tone."}</p>
          <Link href={`/websites/${preview.website.id}/strategy#business-context`} className="text-xs text-sky-700">Edit business facts →</Link>
        </CardBody>
      </Card>
    </div>
  );
}
