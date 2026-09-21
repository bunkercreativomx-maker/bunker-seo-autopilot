import { NextRequest, NextResponse } from "next/server";
import { getSessionClient } from "@/lib/pocketbase/auth";
import { getStrategyJob } from "@/lib/pocketbase/strategy";
import type { User } from "@/lib/types";

/** GET /api/strategy/[jobId] — tenant-scoped strategy generation progress. */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ jobId: string }> }
): Promise<NextResponse> {
  const { jobId } = await context.params;
  const pb = await getSessionClient();
  if (!pb) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const user = pb.authStore.model as unknown as User | null;
  const job = await getStrategyJob(pb, jobId);
  if (!job || !user?.organization || job.organization !== user.organization) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: job.id,
    website: job.website,
    status: job.status,
    stage: job.step ?? job.status,
    progress: job.progress ?? (job.status === "completed" ? 100 : 0),

    started_at: job.started_at,
    completed_at: job.completed_at,
    error_message: job.error,
  });
}
