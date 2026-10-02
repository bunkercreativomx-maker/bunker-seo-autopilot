"use client";

import { PACKAGES } from "@/lib/plan";
import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { TodayState } from "@/app/actions/today";
import { siteSettingsAction, writeNowAction } from "@/app/actions/today";
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

/** A post waiting for the human → one button to the single review screen. */
export function ReadyCard({ post }: { post: TodayPost }) {
  const approved = post.status === "approved";
  return (
    <Link href={`/review/${post.id}`} className="group flex overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md">
      <div className="relative hidden w-44 shrink-0 bg-slate-100 sm:block">
        {post.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={post.image} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-[11px] text-slate-400">Making image…</div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 items-start gap-4 p-5">
        <ScoreRing score={post.score} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{post.websiteName}</p>
          <p className="mt-0.5 text-base font-semibold leading-snug text-slate-900 group-hover:underline">{post.title}</p>
          {post.excerpt && <p className="mt-1 line-clamp-2 text-sm text-slate-500">{post.excerpt}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
            <span className={cn("rounded-lg px-3 py-1.5 text-sm font-semibold text-white", approved ? "bg-amber-500" : "bg-emerald-600")}>
              {approved ? "Approved — publish it →" : "Review & publish →"}
            </span>
            {post.highRisk && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800">Sensitive topic</span>}
            {!post.image && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">Image on the way</span>}
          </div>
        </div>
      </div>
    </Link>
  );
}

/** Switch that submits its NEXT value (no hidden-state race). */
function Toggle({ name, checked, onChange, disabled }: { name: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    // The new value is written into a dedicated field and submitted in the same
    // tick. (A submit button whose value flips on re-render sent the OLD value:
    // switching ON saved OFF.)
    <button type="button" role="switch" aria-checked={checked} disabled={disabled}
      onClick={(e) => {
        const form = e.currentTarget.form;
        const next = !checked;
        const field = form?.querySelector<HTMLInputElement>(`input[data-toggle="${name}"]`);
        if (field) field.value = next ? "on" : "off";
        onChange(next);
        form?.requestSubmit();
      }}
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
        <input type="hidden" name="daily" data-toggle="daily" defaultValue={daily ? "on" : "off"} />
        <span className="text-xs text-slate-600">Posting</span>
        <Toggle name="daily" checked={daily} disabled={!canEdit || save.pending} onChange={setDaily} />
      </form>
      {daily && (
        <form action={save.run} className="flex items-center gap-2" title="Publishes by itself only when the post scores 85+, passes the fact check and has no sensitive topics or unverified claims. Anything else waits here for you.">
          <input type="hidden" name="websiteId" value={site.id} />
          <input type="hidden" name="daily" value="on" />
          <input type="hidden" name="posts" value={posts} />
          <input type="hidden" name="autopublish" data-toggle="autopublish" defaultValue={auto ? "on" : "off"} />
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
