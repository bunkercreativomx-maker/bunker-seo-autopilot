import Link from "next/link";
import { requireUser } from "@/lib/pocketbase/auth";
import { getArticlePerformance } from "@/lib/pocketbase/analytics";
import { Badge, Card, CardBody, EmptyState } from "@/components/ui";
import { fmtCtr, fmtInt, fmtPos } from "@/lib/analytics/format";

export const dynamic = "force-dynamic";

type Pub = { id: string; article: string; public_url: string; status: string; published_at: string; expand?: { article?: { title: string } } };

export default async function PublishedContentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { pb } = await requireUser();
  const pubs = await pb.collection("article_publications").getList<Pub>(1, 50, { filter: `website = "${id}"`, sort: "-published_at", expand: "article", requestKey: null }).then((r) => r.items).catch(() => [] as Pub[]);
  if (pubs.length === 0) return <EmptyState title="No published content" description="Articles published through the Publishing Engine will show their Search Console performance here." />;
  const perf = await Promise.all(pubs.map((p) => getArticlePerformance(pb, p.article)));
  return (
    <Card>
      <CardBody className="overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr><th className="px-4 py-2">Article</th><th className="px-3 py-2">Publication</th><th className="px-3 py-2">Days live</th><th className="px-3 py-2 text-right">Clicks</th><th className="px-3 py-2 text-right">Impressions</th><th className="px-3 py-2 text-right">CTR</th><th className="px-3 py-2 text-right">Avg. position</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pubs.map((p, i) => {
              const a = perf[i];
              const has = a?.hasData && a.totals;
              return (
                <tr key={p.id}>
                  <td className="px-4 py-2"><Link className="text-sky-700" href={`/articles/${p.article}`}>{p.expand?.article?.title ?? p.article}</Link><div className="text-xs text-slate-500">{p.public_url}</div></td>
                  <td className="px-3 py-2"><Badge tone={p.status === "published" ? "green" : "slate"}>{p.status}</Badge></td>
                  <td className="px-3 py-2 text-xs">{a?.daysLive ?? "—"}</td>
                  {has ? (
                    <>
                      <td className="px-3 py-2 text-right">{fmtInt(a!.totals!.clicks)}</td>
                      <td className="px-3 py-2 text-right">{fmtInt(a!.totals!.impressions)}</td>
                      <td className="px-3 py-2 text-right">{fmtCtr(a!.totals!.ctr, a!.totals!.impressions)}</td>
                      <td className="px-3 py-2 text-right">{fmtPos(a!.totals!.position)}</td>
                    </>
                  ) : (
                    <td colSpan={4} className="px-3 py-2 text-xs text-slate-500">{a?.connected === false ? "Search Console not connected." : "No Search Console performance data yet."}</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="px-4 py-2 text-xs text-slate-500">Performance since publication only (days before the publish date are not compared). Source: Google Search Console.</p>
      </CardBody>
    </Card>
  );
}
