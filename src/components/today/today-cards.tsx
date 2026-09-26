"use client";

import { PACKAGES } from "@/lib/plan";
import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { TodayState } from "@/app/actions/today";
import { discardPostAction, publishPostAction, rewritePostAction, siteSettingsAction, writeNowAction } from "@/app/actions/today";
import type { TodayPost, TodaySite } from "@/lib/pocketbase/today";
import { cn } from "@/lib/utils";

type Act = (p: TodayState, f: FormData) => Promise<TodayState>;

function useAct(action: Act) {
  const [state, run, pending] = useActionState<TodayState, FormData>(action, undefined);
  const router = useRouter();
  useEffect(() => { if (state?.ok) router.refresh(); }, [state, router]);
  return { state, run, pending };
}

function Note({ state }: { state: TodayState }) {
  if (!state?.ok && !state?.error) return null;
  return <p className={cn("mt-2 text-xs", state.error ? "text-rose-600" : "text-emerald-700")}>{state.error || state.ok}</p>;
}

export function ScoreRing({ score, blocked }: { score: number | null; blocked?: boolean }) {
  const v = score ?? 0;
  const tone = blocked ? "text-rose-500" : v >= 85 ? "text-emerald-500" : v >= 70 ? "text-amber-500" : "text-rose-500";
  const c = 2 * Math.PI * 18;
  return (
    <div className="relative h-12 w-12 shrink-0" title={blocked ? "Blocked by the checker" : "Quality score"}>
      <svg viewBox="0 0 44 44" className="h-12 w-12 -rotate-90">
        <circle cx="22" cy="22" r="18" fill="none" stroke="currentColor" strokeWidth="4" className="text-slate-100" />
        <circle cx="22" cy="22" r="18" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className={tone}
          strokeDasharray={c} strokeDashoffset={c - (c * v) / 100} />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-slate-800">{score ?? "–"}</span>
    </div>
  );
}

/** A post waiting for the human: Publish · Edit · Rewrite · Discard. */
export function ReadyCard({ post }: { post: TodayPost }) {
  const pub = useAct(publishPostAction);
  const dis = useAct(discardPostAction);
  const rew = useAct(rewritePostAction);
  const [mode, setMode] = useState<"" | "rewrite" | "discard">("");
  const needsTick = post.highRisk || post.qaStatus === "NEEDS_REVISION" || pub.state?.needsReview;
  const busy = pub.pending || dis.pending || rew.pending;
  const hidden = <><input type="hidden" name="articleId" value={post.id} /><input type="hidden" name="websiteId" value={post.websiteId} /></>;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md">
      <div className="flex items-start gap-4">
        <ScoreRing score={post.score} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{post.websiteName}</p>
          <Link href={`/articles/${post.id}`} className="mt-0.5 block text-base font-semibold leading-snug text-slate-900 hover:underline">{post.title}</Link>
          {post.excerpt && <p className="mt-1 line-clamp-2 text-sm text-slate-500">{post.excerpt}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
            {post.keyword && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">🔎 {post.keyword}</span>}
            {post.highRisk && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800">Sensitive topic</span>}
            {post.qaStatus === "NEEDS_REVISION" && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800">Checker left notes</span>}
          </div>
        </div>
      </div>

      <form action={pub.run} className="mt-4 flex flex-wrap items-center gap-2">
        {hidden}
        {needsTick && (
          <label className="flex w-full items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" name="reviewed" className="h-4 w-4 rounded border-slate-300" /> I read it and it’s correct
          </label>
        )}
        <button disabled={busy} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
          {pub.pending ? "Publishing…" : "Publish"}
        </button>
        <Link href={`/articles/${post.id}`} className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">Edit</Link>
        <button type="button" onClick={() => setMode(mode === "rewrite" ? "" : "rewrite")} className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">Rewrite</button>
        <button type="button" onClick={() => setMode(mode === "discard" ? "" : "discard")} className="ml-auto rounded-lg px-3 py-2 text-sm font-medium text-slate-400 hover:bg-rose-50 hover:text-rose-600">Discard</button>
      </form>
      <Note state={pub.state} />

      {mode === "rewrite" && (
        <form action={rew.run} className="mt-3 flex gap-2">
          {hidden}
          <input name="instruction" placeholder="What should change? e.g. shorter, add free quote CTA" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <button disabled={busy} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{rew.pending ? "…" : "Send"}</button>
        </form>
      )}
      <Note state={rew.state} />
      {mode === "discard" && (
        <form action={dis.run} className="mt-3 flex gap-2">
          {hidden}
          <input name="reason" placeholder="Why? (optional)" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <button disabled={busy} className="rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{dis.pending ? "…" : "Discard"}</button>
        </form>
      )}
      <Note state={dis.state} />
    </div>
  );
}

/** Switch that submits its NEXT value (no hidden-state race). */
function Toggle({ name, checked, onChange, disabled }: { name: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="submit" name={name} value={checked ? "off" : "on"} role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
      className={cn("relative inline-flex h-6 w-11 shrink-0 rounded-full transition", checked ? "bg-emerald-500" : "bg-slate-300", disabled && "opacity-40")}>
      <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition", checked ? "left-[22px]" : "left-0.5")} />
    </button>
  );
}

/** One row per website: a single "Daily post" switch + Write now. */
export function SiteRow({ site, canEdit }: { site: TodaySite; canEdit: boolean }) {
  const save = useAct(siteSettingsAction);
  const now = useAct(writeNowAction);
  const [daily, setDaily] = useState(site.dailyOn);
  const [auto, setAuto] = useState(site.autoPublish);
  const [posts, setPosts] = useState(site.postsPerMonth || 30);
  return (
    <div className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <Link href={`/websites/${site.id}`} className="text-sm font-semibold text-slate-900 hover:underline">{site.name}</Link>
        <p className="text-xs text-slate-500">
          {site.domain}
          {" · "}
          {site.connected ? <span className="text-emerald-700">connected{site.environment === "staging" ? " (staging)" : ""}</span> : <Link href={`/websites/${site.id}/publishing`} className="text-amber-700 underline">connect website</Link>}
        </p>
      </div>
      <form action={save.run} className="flex items-center gap-2">
        <input type="hidden" name="websiteId" value={site.id} />
        <input type="hidden" name="autopublish" value={auto ? "on" : "off"} />
        <input type="hidden" name="posts" value={posts} />
        <span className="text-xs text-slate-600">Posting</span>
        <Toggle name="daily" checked={daily} disabled={!canEdit || save.pending} onChange={setDaily} />
      </form>
      {daily && (
        <form action={save.run} className="flex items-center gap-2" title="Publishes by itself only when the post scores 85+, passes the fact check and has no sensitive topics or unverified claims. Anything else waits here for you.">
          <input type="hidden" name="websiteId" value={site.id} />
          <input type="hidden" name="daily" value="on" />
          <input type="hidden" name="posts" value={posts} />
          <span className="text-xs text-slate-600">Auto-publish safe posts</span>
          <Toggle name="autopublish" checked={auto} disabled={!canEdit || save.pending || !site.connected} onChange={setAuto} />
        </form>
      )}
      {daily && (
        <form action={save.run} className="flex items-center gap-1" aria-label="Posts per month">
          <input type="hidden" name="websiteId" value={site.id} />
          <input type="hidden" name="daily" value="on" />
          <input type="hidden" name="autopublish" value={auto ? "on" : "off"} />
          <input type="hidden" name="posts" value={posts} />
          <div className="inline-flex rounded-lg bg-slate-100 p-0.5">
            {PACKAGES.map((n) => (
              <button
                key={n}
                type="submit"
                disabled={!canEdit || save.pending}
                onClick={(e) => { setPosts(n); (e.currentTarget.form!.elements.namedItem("posts") as HTMLInputElement).value = String(n); }}
                className={cn("rounded-md px-2.5 py-1 text-xs font-semibold transition", posts === n ? "bg-white text-sky-700 shadow-sm" : "text-slate-500 hover:text-slate-800")}
              >
                {n}
              </button>
            ))}
          </div>
          <span className="text-xs text-slate-500">/ month</span>
        </form>
      )}
      {daily && canEdit && (
        <form action={now.run}>
          <input type="hidden" name="websiteId" value={site.id} />
          <button disabled={now.pending} className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 disabled:opacity-50">
            {now.pending ? "…" : "Write one now"}
          </button>
        </form>
      )}
      <div className="w-full"><Note state={save.state} /><Note state={now.state} /></div>
    </div>
  );
}
