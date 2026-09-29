import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser, canWrite } from "@/lib/pocketbase/auth";
import { getArticleBundle } from "@/lib/pocketbase/content";
import { getPublication } from "@/lib/pocketbase/publishing";
import { ReviewScreen } from "@/components/review/review-screen";

export const dynamic = "force-dynamic";

// ONE screen per post: see it exactly like the blog (image included), fix it
// in place, and approve + publish with one button.
export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { pb, user } = await requireUser();
  const bundle = await getArticleBundle(pb, id);
  if (!bundle) notFound();
  const { article: a, jobs, claims } = bundle;
  const pub = await getPublication(pb, a.id).catch(() => null);
  const job = jobs.find((j) => j.status === "queued" || j.status === "running");
  const lastFailed = !job && (a.status === "failed" || jobs[0]?.status === "failed");
  const w = a.expand?.website;
  const version = Number(a.current_version || 0);
  const issues = claims
    .filter((c) => Number(c.version) === version && ["UNVERIFIED", "CONTRADICTED"].includes(c.verification_status) && c.risk_level !== "low")
    .map((c) => ({ text: c.claim, status: c.verification_status }))
    .slice(0, 8);
  const raw = a.qa_score as unknown;
  const score = typeof raw === "number" ? Math.round(raw) : raw && typeof raw === "object" && typeof (raw as { score?: unknown }).score === "number" ? Math.round((raw as { score: number }).score) : null;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center justify-between text-sm">
        <Link href="/today" className="text-slate-500 hover:text-slate-800">← Today</Link>
        <Link href={`/articles/${a.id}?advanced=1`} className="text-xs text-slate-400 hover:text-slate-600">Advanced view</Link>
      </div>
      <ReviewScreen
        canEdit={canWrite(user.role)}
        post={{
          id: a.id,
          websiteId: a.website as unknown as string,
          websiteName: w?.name || w?.domain || "",
          domain: w?.domain || "",
          status: a.status,
          title: a.title || a.primary_keyword || "",
          excerpt: a.excerpt || "",
          metaDescription: a.meta_description || "",
          content: a.content || "",
          image: a.featured_image || "",
          keyword: a.primary_keyword || "",
          score,
          qaStatus: a.qa_status || "",
          qaSummary: a.qa_summary || "",
          factStatus: a.fact_check_status || "",
          highRisk: Boolean(a.high_risk),
          version,
          publicUrl: (pub as { public_url?: string } | null)?.public_url || "",
          jobStep: job ? job.step || job.status : "",
          failed: Boolean(lastFailed),
          issues,
        }}
      />
    </div>
  );
}
