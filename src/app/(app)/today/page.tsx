import Link from "next/link";
import { requireUser, isAdmin } from "@/lib/pocketbase/auth";
import { loadToday } from "@/lib/pocketbase/today";
import { ReadyCard, ScoreRing, SiteRow } from "@/components/today/today-cards";
import { formatRelative } from "@/lib/format";

export const dynamic = "force-dynamic";

const STEP: Record<string, string> = {
  queued: "Starting", researching: "Researching", brief_ready: "Planning", outlining: "Outlining", drafting: "Writing",
  draft: "Writing", fact_checking: "Checking facts", qa: "Scoring", revising: "Polishing",
};

export default async function TodayPage() {
  const { pb, user } = await requireUser();
  const t = await loadToday(pb);
  const canEdit = isAdmin(user.role);
  const hour = new Date().getUTCHours() - 6;
  const hello = hour < 12 ? "Good morning" : hour < 19 ? "Good afternoon" : "Good evening";
  const first = (user.name || "").split(" ")[0];

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{hello}{first ? `, ${first}` : ""}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {t.ready.length === 0 ? "Nothing to review right now." : `${t.ready.length} post${t.ready.length === 1 ? "" : "s"} ready for you.`}
          {t.writing.length > 0 && ` ${t.writing.length} being written.`}
        </p>
      </header>

      {/* 1. Ready to publish */}
      <section className="space-y-3">
        {t.ready.map((p) => <ReadyCard key={p.id} post={p} />)}
        {t.ready.length === 0 && (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center">
            <p className="text-3xl">☕</p>
            <p className="mt-2 text-sm font-medium text-slate-700">You’re all caught up</p>
            <p className="mt-1 text-xs text-slate-500">New posts appear here every morning for sites with “Daily post” on.</p>
          </div>
        )}
      </section>

      {/* 2. Being written */}
      {t.writing.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Being written</h2>
          <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
            {t.writing.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-3">
                <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-sky-500" /></span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{p.title}</p>
                  <p className="text-xs text-slate-500">{p.websiteName}</p>
                </div>
                <span className="text-xs text-slate-500">{STEP[p.status] ?? "Working"}…</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 3. Needs a look (failed checks) */}
      {t.attention.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Couldn’t finish — take a look</h2>
          <div className="divide-y divide-slate-100 rounded-2xl border border-amber-200 bg-amber-50/40">
            {t.attention.map((p) => (
              <Link key={p.id} href={`/articles/${p.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-amber-50">
                <ScoreRing score={p.score} blocked />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{p.title}</p>
                  <p className="text-xs text-slate-500">
                    {p.websiteName} · {p.status === "publish_failed" ? "Couldn’t publish to the website" : p.factStatus === "blocked" ? "Has claims we couldn’t verify" : "Didn’t pass the quality check"}
                  </p>
                </div>
                <span className="text-xs font-medium text-amber-700">Open →</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* 4. Recently published */}
      {t.live.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Recently published</h2>
          <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
            {t.live.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-3">
                <span className="text-emerald-500">●</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-slate-800">{p.title}</p>
                  <p className="text-xs text-slate-500">{p.websiteName} · {formatRelative(p.updated)}</p>
                </div>
                {p.publicUrl ? <a href={p.publicUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-sky-700 hover:underline">View ↗</a> : <span className="text-xs text-slate-400">{p.status === "published" ? "Live" : "Publishing…"}</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 5. Websites: one switch each */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Your websites</h2>
          {canEdit && <Link href="/websites/new" className="text-xs font-medium text-sky-700 hover:underline">+ Add website</Link>}
        </div>
        <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white px-4">
          {t.sites.map((s) => <SiteRow key={s.id} site={s} canEdit={canEdit} />)}
          {t.sites.length === 0 && <p className="py-6 text-center text-sm text-slate-500">No websites yet.</p>}
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Daily post on = every morning Autopilot picks the best topic, writes it, checks facts and scores it. Nothing goes live until you press Publish.
        </p>
      </section>
    </div>
  );
}
