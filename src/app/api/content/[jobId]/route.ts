import { NextRequest, NextResponse } from "next/server";
import { getSessionClient } from "@/lib/pocketbase/auth";
import { getContentJob } from "@/lib/pocketbase/content";
import type { User } from "@/lib/types";

/** GET /api/content/[jobId] — tenant-scoped content job progress. */
export async function GET(_request: NextRequest, context: { params: Promise<{ jobId: string }> }): Promise<NextResponse> {
  const { jobId } = await context.params;
  const pb = await getSessionClient();
  if (!pb) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const user = pb.authStore.model as unknown as User | null;
  const job = await getContentJob(pb, jobId);
  if (!job || !user?.organization || job.organization !== user.organization) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({
    id: job.id,
    article: job.article,
    mode: job.mode,
    status: job.status,
    step: job.step ?? job.status,
    progress: job.progress ?? (job.status === "completed" ? 100 : 0),
    error: job.error,
    error_code: job.error_code,
  });
}
