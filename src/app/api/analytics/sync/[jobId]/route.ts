import { NextRequest, NextResponse } from "next/server";
import { getSessionClient } from "@/lib/pocketbase/auth";
import type { SyncJob } from "@/lib/analytics/types";

/** GET /api/analytics/sync/[jobId] — progress polling (org-scoped by PocketBase rules). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ jobId: string }> }): Promise<NextResponse> {
  const { jobId } = await ctx.params;
  const pb = await getSessionClient();
  if (!pb) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const j = await pb.collection("gsc_sync_jobs").getOne<SyncJob>(jobId, { requestKey: null });
    return NextResponse.json({
      id: j.id, status: j.status, step: j.step, progress: j.progress, start_date: j.start_date, end_date: j.end_date,
      rows_received: j.rows_received, rows_stored: j.rows_stored, error_code: j.error_code, error_message: j.error_message, completed_at: j.completed_at,
    }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
