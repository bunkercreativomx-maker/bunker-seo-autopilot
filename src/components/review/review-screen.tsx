"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Markdown } from "@/components/content/markdown";
import { cn } from "@/lib/utils";
import type { ReviewState } from "@/app/actions/review";
import { approvePublishAction, autoFixAction, discardReviewAction, newImageAction, retryReviewAction, reviewRewriteAction, saveReviewAction } from "@/app/actions/review";

export type ReviewPost = {
  id: string; websiteId: string; websiteName: string; domain: string; status: string;
  title: string; excerpt: string; metaDescription: string; content: string; image: string; keyword: string;
  score: number | null; qaStatus: string; qaSummary: string; factStatus: string; highRisk: boolean; version: number;
  publicUrl: string; jobStep: string; failed: boolean; issues: Array<{ text: string; status: string }>;
};

type Act = (p: ReviewState, f: FormData) => Promise<ReviewState>;
function useAct(action: Act) {
  const [state, run, pending] = useActionState<ReviewState, FormData>(action, undefined);
  const router = useRouter();
  useEffect(() => { if (state?.ok) router.refresh(); }, [state, router]);
  return { state, run, pending };
}
function Note({ state }: { state: ReviewState }) {
  if (!state?.ok && !state?.error) return null;
  return <p className={cn("text-xs", state.error ? "text-rose-600" : "text-emerald-700")}>{state.error || state.ok}</p>;
}

const WORKING: Record<string, string> = {
  queued: "Starting…", building_context: "Reading the business…", researching: "Researching…", building_brief: "Planning…",
  creating_outline: "Outlining…", writing_draft: "Writing…", optimizing_seo: "Optimizing SEO…", checking_claims: "Checking facts…",
  fact_checking: "Checking facts…", quality_review: "Scoring quality…", revising: "Polishing…", running: "Working…",
};
const REVIEWABLE = ["awaiting_approval", "needs_revision", "draft"];
const LIVE = ["published", "publish_queued", "publishing"];

export function ReviewScreen({ post, canEdit }: { post: ReviewPost; canEdit: boolean }) {
  const router = useRouter();
  const [editOpen, setEditing] = useState(false);
  const [panel, setPanel] = useState<"" | "image" | "rewrite" | "discard">("");
  const save = useAct(saveReviewAction);
  const [savedAt, setSavedAt] = useState<ReviewState>(undefined);
  const editing = editOpen && !(save.state?.ok && savedAt === save.state);
  const img = useAct(newImageAction);
  const rew = useAct(reviewRewriteAction);
  const pub = useAct(approvePublishAction);
  const dis = useAct(discardReviewAction);
  const retry = useAct(retryReviewAction);
  const fix = useAct(autoFixAction);

  const working = Boolean(post.jobStep);
  const waitingImage = !post.image && REVIEWABLE.includes(post.status) && Boolean(post.content);
  const publishing = ["publish_queued", "publishing"].includes(post.status);
  // Keep the page fresh while something is happening in the background.
  useEffect(() => {
    if (!(working || waitingImage || publishing || fix.state?.ok || retry.state?.ok || img.state?.ok || rew.state?.ok || save.state?.ok || pub.state?.ok)) return;
    const t = setInterval(() => router.refresh(), 6000);
    return () => clearInterval(t);
  }, [working, waitingImage, publishing, fix.state, retry.state, img.state, rew.state, save.state, pub.state, router]);

  const hidden = <><input type="hidden" name="articleId" value={post.id} /><input type="hidden" name="websiteId" value={post.websiteId} /><input type="hidden" name="status" value={post.status} /></>;
  const reviewable = REVIEWABLE.includes(post.status) && canEdit;
  const checksPending = ["stale", "pending", ""].includes(post.qaStatus) || ["stale", "pending", ""].includes(post.factStatus);
  const blocked = post.qaStatus === "BLOCKED" || post.factStatus === "blocked";
  const needsTick = post.highRisk || post.qaStatus === "NEEDS_REVISION" || Boolean(pub.state?.needsReview);
  const canPublish = canEdit && !working && !editing && !blocked && !checksPending && ["awaiting_approval", "approved", "publish_failed"].includes(post.status) && Boolean(post.image);
  const busy = save.pending || img.pending || rew.pending || pub.pending || dis.pending || retry.pending || fix.pending;
  // Plain-words reason whenever Publish can't be pressed.
  let why = "";
  if (!canPublish && !LIVE.includes(post.status) && post.status !== "rejected") {
    if (working) why = "Wait — it’s still working on this post.";
    else if (post.failed) why = "The writer got stuck. Press “Try again” above.";
    else if (blocked) why = "Blocked: some sentences couldn’t be verified. Press “Fix it for me”.";
    else if (checksPending) why = "Checking the latest changes (1–2 min)…";
    else if (!post.image) why = "Waiting for the featured image (about 1 min)…";
    else if (editing) why = "Save or close the editor first.";
    else if (post.status === "needs_revision") why = "Being revised.";
  }

  // ---- status line (plain words)
  let status: { tone: "green" | "amber" | "red" | "blue" | "slate"; text: string };
  if (LIVE.includes(post.status)) status = { tone: post.status === "published" ? "green" : "blue", text: post.status === "published" ? "Live on the website" : "Publishing…" };
  else if (working) status = { tone: "blue", text: WORKING[post.jobStep] || "Working…" };
  else if (post.status === "rejected") status = { tone: "slate", text: "Discarded" };
  else if (post.failed) status = { tone: "red", text: "The writer got stuck on this post. Press “Try again”." };
  else if (blocked) status = { tone: "red", text: "The checker found claims it couldn’t verify — fix them below or rewrite." };
  else if (checksPending) status = { tone: "blue", text: "Checking the latest changes…" };
  else if (waitingImage) status = { tone: "blue", text: "Making the featured image…" };
  else if (post.status === "approved") status = { tone: "amber", text: "Approved — press Publish to put it on the website." };
  else if (post.status === "publish_failed") status = { tone: "red", text: "Couldn’t reach the website — try Publish again." };
  else status = { tone: "green", text: needsTick ? "Ready. Read it once, tick the box and publish." : "Ready to publish." };
  const tones = { green: "bg-emerald-50 text-emerald-800 ring-emerald-200", amber: "bg-amber-50 text-amber-800 ring-amber-200", red: "bg-rose-50 text-rose-800 ring-rose-200", blue: "bg-sky-50 text-sky-800 ring-sky-200", slate: "bg-slate-50 text-slate-700 ring-slate-200" };

  if (post.status === "rejected") {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center">
        <p className="text-3xl">🗑️</p>
        <p className="mt-2 text-base font-semibold text-slate-800">This post was discarded</p>
        <p className="mt-1 text-sm text-slate-500">It won’t be published, it’s hidden from your lists, and Autopilot won’t write this topic again.</p>
        <a href="/today" className="mt-5 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white">Back to Today</a>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-32">
      {/* status */}
      <div className={cn("flex flex-wrap items-center gap-3 rounded-xl px-4 py-3 text-sm ring-1 ring-inset", tones[status.tone])}>
        {(working || checksPending || waitingImage || publishing) && <span className="h-2 w-2 animate-pulse rounded-full bg-current" />}
        <span className="font-medium">{status.text}</span>
        <span className="ml-auto flex flex-wrap gap-1.5 text-[11px]">
          {post.score !== null && <span className="rounded-full bg-white/70 px-2 py-0.5">Quality {post.score}/100</span>}
          {post.keyword && <span className="rounded-full bg-white/70 px-2 py-0.5">🔎 {post.keyword}</span>}
          {post.highRisk && <span className="rounded-full bg-white/70 px-2 py-0.5">Sensitive topic</span>}
          {post.publicUrl && post.status === "published" && <a href={post.publicUrl} target="_blank" rel="noreferrer" className="rounded-full bg-white px-2 py-0.5 font-medium underline">View live ↗</a>}
        </span>
      </div>

      {post.failed && !working && canEdit && (
        <form action={retry.run} className="flex items-center gap-3">
          {hidden}
          <button disabled={retry.pending} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{retry.pending ? "…" : "Try again"}</button>
          <Note state={retry.state} />
        </form>
      )}

      {post.issues.length > 0 && !working && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-amber-900">
          <div className="flex flex-wrap items-center gap-3">
            <p className="font-medium">{blocked ? `${post.issues.length} sentence${post.issues.length === 1 ? "" : "s"} couldn’t be verified — this blocks publishing.` : "Double-check these sentences:"}</p>
            {blocked && canEdit && (
              <form action={fix.run} className="ml-auto">
                {hidden}
                {post.issues.map((i, k) => <input key={k} type="hidden" name="flagged" value={i.text} />)}
                <button disabled={busy} className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50">{fix.pending ? "…" : "✨ Fix it for me"}</button>
              </form>
            )}
          </div>
          <Note state={fix.state} />
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[13px]">{post.issues.map((i, k) => <li key={k}>{i.text}</li>)}</ul>
        </div>
      )}

      {/* the post, as it will look on the blog */}
      <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="relative aspect-[16/8] w-full bg-slate-100">
          {post.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={post.image} alt="" className="h-full w-full object-cover" />
          ) : !post.content ? (
            <div className="flex h-full w-full items-center justify-center text-xs text-slate-400">The image is made once the post is written.</div>
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-slate-400">
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-slate-500" />
              <span className="text-xs">Making the featured image…</span>
            </div>
          )}
          {reviewable && !working && (
            <button type="button" onClick={() => setPanel(panel === "image" ? "" : "image")}
              className="absolute right-3 top-3 rounded-lg bg-white/90 px-3 py-1.5 text-xs font-semibold text-slate-800 shadow hover:bg-white">
              🖼 {post.image ? "Change image" : "Describe the image"}
            </button>
          )}
        </div>
        {panel === "image" && (
          <form action={img.run} className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50 px-5 py-3">
            {hidden}
            <input name="hint" placeholder="Optional: what should it show? e.g. technician fixing a rooftop AC unit" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <button disabled={busy} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{img.pending ? "…" : "New image"}</button>
            <div className="w-full"><Note state={img.state} /></div>
          </form>
        )}

        {editing ? (
          <form action={save.run} className="space-y-3 px-6 py-6 sm:px-10">
            {hidden}
            <label className="block text-xs font-medium text-slate-500">Title
              <input name="title" defaultValue={post.title} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xl font-semibold text-slate-900" />
            </label>
            <label className="block text-xs font-medium text-slate-500">Intro (shown on the blog card)
              <textarea name="excerpt" defaultValue={post.excerpt} rows={2} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <label className="block text-xs font-medium text-slate-500">Google description
              <textarea name="meta_description" defaultValue={post.metaDescription} rows={2} maxLength={320} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <label className="block text-xs font-medium text-slate-500">Article (## = heading, - = bullet)
              <textarea name="content" defaultValue={post.content} rows={24} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-[13px] leading-6" />
            </label>
            <div className="flex items-center gap-2">
              <button disabled={busy} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{save.pending ? "Saving…" : "Save changes"}</button>
              <button type="button" onClick={() => setEditing(false)} className="rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
              <Note state={save.state} />
            </div>
          </form>
        ) : (
          <div className="px-6 py-6 sm:px-10">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{post.websiteName} · Blog</p>
            <h1 className="mt-2 text-3xl font-bold leading-tight tracking-tight text-slate-900">{post.title}</h1>
            {post.excerpt && <p className="mt-3 text-lg leading-7 text-slate-500">{post.excerpt}</p>}
            <div className="mt-6 border-t border-slate-100 pt-2">
              {post.content ? <Markdown source={post.content} skipFirstH1 /> : <p className="py-10 text-center text-sm text-slate-400">Writing…</p>}
            </div>
          </div>
        )}
      </article>
      <Note state={save.state} />

      {/* one action bar */}
      {canEdit && post.status !== "rejected" && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 backdrop-blur lg:left-64">
          <div className="mx-auto max-w-4xl space-y-2 px-4 py-3">
            {panel === "rewrite" && (
              <form action={rew.run} className="flex gap-2">
                {hidden}
                <input name="instruction" autoFocus placeholder="What should change? e.g. shorter, friendlier, mention free estimates" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                <button disabled={busy} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{rew.pending ? "…" : "Rewrite"}</button>
              </form>
            )}
            {panel === "discard" && (
              <form action={dis.run} className="flex gap-2">
                {hidden}
                <input name="reason" placeholder="Why? (optional)" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                <button disabled={busy} className="rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{dis.pending ? "…" : "Discard post"}</button>
              </form>
            )}
            <form action={pub.run} className="flex flex-wrap items-center gap-2">
              {hidden}
              {!LIVE.includes(post.status) && (
                <>
                  {needsTick && ["awaiting_approval", "approved", "publish_failed"].includes(post.status) && (
                    <label className="mr-1 flex items-center gap-2 text-xs text-slate-700">
                      <input type="checkbox" name="reviewed" className="h-4 w-4 rounded border-slate-300" /> I read it and it’s correct
                    </label>
                  )}
                  <button disabled={!canPublish || busy} title={!post.image ? "Waiting for the image" : checksPending ? "Checking the latest changes" : ""}
                    className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40">
                    {pub.pending ? "Publishing…" : post.status === "awaiting_approval" ? "Approve & publish" : "Publish"}
                  </button>
                </>
              )}
              {reviewable && !working && (
                <>
                  <button type="button" onClick={() => { setSavedAt(save.state); setEditing(!editing); setPanel(""); }} className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">{editing ? "Close editor" : "✏️ Edit"}</button>
                  <button type="button" onClick={() => setPanel(panel === "rewrite" ? "" : "rewrite")} className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">✨ Rewrite with AI</button>
                  <button type="button" onClick={() => setPanel(panel === "discard" ? "" : "discard")} className="ml-auto rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-rose-50 hover:text-rose-600">Discard</button>
                </>
              )}
            </form>
            {why && !pub.state?.error && <p className="text-xs font-medium text-amber-700">{why}</p>}
            <Note state={pub.state} /><Note state={rew.state} /><Note state={dis.state} />
          </div>
        </div>
      )}
    </div>
  );
}
