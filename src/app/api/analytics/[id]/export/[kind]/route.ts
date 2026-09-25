import { NextRequest, NextResponse } from "next/server";
import { getSessionClient } from "@/lib/pocketbase/auth";
import { userOperation } from "@/lib/pocketbase/operations";
import { csvEscape } from "@/lib/analytics/format";
import type { Opportunity, PageRow, Paged, QueryRow } from "@/lib/analytics/types";

/**
 * CSV export (queries / pages / opportunities) of data the signed-in user is
 * authorized to view. Aggregation and tenant checks happen in PocketBase.
 * Never includes OAuth material or internal credentials.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; kind: string }> }): Promise<NextResponse> {
  const { id, kind } = await ctx.params;
  const pb = await getSessionClient();
  if (!pb) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const range = req.nextUrl.searchParams.get("range") || "28d";
  const lines: string[] = [];
  const row = (cells: unknown[]) => lines.push(cells.map(csvEscape).join(","));
  try {
    if (kind === "queries" || kind === "pages") {
      const all: Array<QueryRow | PageRow> = [];
      let meta: Paged<QueryRow | PageRow> | null = null;
      for (let page = 1; page <= 50; page++) {
        const r = await userOperation<Paged<QueryRow | PageRow>>(pb, `analytics/${kind}`, { websiteId: id, range, page, perPage: 100 });
        meta = r;
        all.push(...r.rows);
        if (r.rows.length < 100) break;
      }
      row([`# Source: Google Search Console · ${meta?.period ? `${meta.period.start} to ${meta.period.end}` : "no data"} · finalized data`]);
      if (kind === "queries") {
        row(["# Search Console may omit anonymized or lower-volume queries."]);
        row(["query", "clicks", "impressions", "ctr", "average_position", "prev_clicks", "prev_impressions", "landing_page", "mapping", "intent", "brand"]);
        for (const r of all as QueryRow[]) row([r.query, r.clicks, r.impressions, r.ctr.toFixed(6), r.position?.toFixed(2) ?? "", r.previous.clicks, r.previous.impressions, r.landing_page, r.mapping, r.intent, r.brand]);
      } else {
        row(["page", "clicks", "impressions", "ctr", "average_position", "prev_clicks", "prev_impressions", "published_article", "strategy_keywords"]);
        for (const r of all as PageRow[]) row([r.page, r.clicks, r.impressions, r.ctr.toFixed(6), r.position?.toFixed(2) ?? "", r.previous.clicks, r.previous.impressions, r.mapping.article?.title ?? "", (r.mapping.strategy_keywords ?? []).join(" | ")]);
      }
    } else if (kind === "opportunities") {
      const items = await pb.collection("analytics_opportunities").getFullList<Opportunity>({ filter: `website = "${id.replace(/[^a-z0-9]/g, "")}"`, sort: "-last_detected_at", requestKey: null });
      row(["type", "status", "priority", "query", "page", "reason", "recommended_action", "first_detected_at", "last_detected_at", "source"]);
      for (const o of items) row([o.type, o.status, o.priority, o.query, o.page, o.reason, o.recommended_action, o.first_detected_at, o.last_detected_at, o.source]);
    } else {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return new NextResponse(lines.join("\n") + "\n", {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="gsc-${kind}-${range}.csv"`, "cache-control": "no-store" },
  });
}
