import { NextRequest, NextResponse } from "next/server";
import { getSessionClient } from "@/lib/pocketbase/auth";
import type { CrawlJob } from "@/lib/types";

/** GET /api/crawl/[jobId] — crawl job progress + live counts for polling. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ jobId: string }> }): Promise<NextResponse> {
  const { jobId } = await ctx.params;
  const pb = await getSessionClient();
  if (!pb) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let job: CrawlJob;
  try {
    job = await pb.collection("crawl_jobs").getOne<CrawlJob>(jobId);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let pagesCrawled = 0;
  try {
    pagesCrawled = (await pb.collection("website_pages").getFullList<CrawlJob>({ filter: `website = "${job.website}"` })).length;
  } catch {}

  return NextResponse.json({
    id: job.id,
    website: job.website,
    status: job.status,
    started_at: job.started_at,
    completed_at: job.completed_at,
    pages_discovered: job.pages_discovered ?? pagesCrawled,
    pages_crawled: job.pages_crawled ?? pagesCrawled,
    pages_failed: job.pages_failed ?? 0,
    errors_count: job.errors_count ?? 0,
    error_message: job.error_message,
  });
}