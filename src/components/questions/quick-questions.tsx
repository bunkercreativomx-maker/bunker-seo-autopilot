"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { answerQuestionAction, type AnswerState } from "@/app/actions/questions";
import type { QuickQuestion } from "@/lib/pocketbase/questions";
import { cn } from "@/lib/utils";

const btn = "min-w-16 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:border-slate-400 hover:bg-slate-50 disabled:opacity-40";

function QuestionCard({ q, showSite }: { q: QuickQuestion; showSite: boolean }) {
  const [state, run, pending] = useActionState<AnswerState, FormData>(answerQuestionAction, undefined);
  const router = useRouter();
  const answer = useRef<HTMLInputElement>(null);
  const [detail, setDetail] = useState("");
  // Optional details appear only after "Yes", so the first choice is a clean Yes / No.
  const [expanded, setExpanded] = useState(q.input !== "none" && !q.optional);
  useEffect(() => { if (state?.ok) router.refresh(); }, [state, router]);

  const needsValue = q.input !== "none" && !q.optional;

  if (state?.ok) {
    return <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-sm text-emerald-800">✓ {state.ok}</div>;
  }
  return (
    <form action={run} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <input type="hidden" name="websiteId" value={q.websiteId} />
      <input type="hidden" name="key" value={q.key} />
      <input ref={answer} type="hidden" name="answer" defaultValue="" />
      {showSite && <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{q.websiteName}</p>}
      <p className="mt-0.5 text-sm font-semibold text-slate-900">{q.q}</p>
      {q.kind === "confirm" && (
        <blockquote className="mt-2 rounded-lg border-l-4 border-sky-300 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          <span className="text-xs font-medium text-slate-500">{q.label}: </span>{q.value}
        </blockquote>
      )}
      {q.hint && <p className="mt-1 text-xs text-slate-500">{q.hint}</p>}
      {q.input !== "none" && expanded && (
        q.input === "number" ? (
          <input name="detail" type="number" inputMode="numeric" min={1} max={199} value={detail} onChange={(e) => setDetail(e.target.value)}
            placeholder={q.placeholder || ""} className="mt-3 w-28 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        ) : (
          q.key === "review"
            ? <textarea name="detail" rows={3} value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={600}
                placeholder={q.placeholder || ""} className="mt-3 w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            : <input name="detail" value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={600} autoFocus
                placeholder={q.placeholder || ""} className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        )
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {q.optional && !expanded ? (
          <button key="open" type="button" onClick={(e) => { e.preventDefault(); setExpanded(true); }} disabled={pending} className={btn}>Yes</button>
        ) : (
          <button key="save" type="submit" onClick={() => { if (answer.current) answer.current.value = "yes"; }} disabled={pending || (needsValue && !detail.trim())}
            className={cn(btn, expanded && "border-slate-900 bg-slate-900 text-white hover:bg-slate-800")}>
            {expanded ? "Save" : "Yes"}
          </button>
        )}
        {q.allowNo && !expanded && (
          <button type="submit" onClick={() => { if (answer.current) answer.current.value = "no"; }} disabled={pending} className={btn}>No</button>
        )}
        {q.optional && expanded && (
          <button type="button" onClick={() => setExpanded(false)} disabled={pending} className="rounded-lg px-3 py-2 text-sm text-slate-500 hover:text-slate-800">Back</button>
        )}
        <button type="submit" onClick={() => { if (answer.current) answer.current.value = "skip"; }} disabled={pending}
          className="ml-auto rounded-lg px-3 py-2 text-sm text-slate-500 hover:bg-slate-50 hover:text-slate-800 disabled:opacity-40">
          {q.key === "review" ? "I don't have one" : "Skip"}
        </button>
        {needsValue && !detail.trim() && <span className="w-full text-[11px] text-slate-400">{q.input === "number" ? "Type the number to save." : "Paste it to save."}</span>}
        {pending && <span className="text-xs text-slate-500">Saving…</span>}
      </div>
      {state?.error && <p className="mt-2 text-xs text-rose-600">{state.error}</p>}
    </form>
  );
}

/**
 * Quick questions: a few Yes/No taps that make posts both TRUE and more
 * convincing. Yes = posts may say it; No = posts will never say it.
 */
export function QuickQuestions({ questions, limit = 3, showSite: showSiteProp = true, moreHref, className }: {
  questions: QuickQuestion[]; limit?: number; showSite?: boolean; moreHref?: string; className?: string;
}) {
  if (!questions.length) return null;
  const shown = questions.slice(0, limit);
  const showSite = showSiteProp && new Set(questions.map((q) => q.websiteId)).size > 1;
  const rest = questions.length - shown.length;
  return (
    <section className={cn("space-y-3", className)}>
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Quick questions · {questions.length}</h2>
        <p className="mt-0.5 text-xs text-slate-500">Posts only state what your site or your answers confirm — nothing is invented. Each answer makes them more convincing.</p>
      </div>
      {shown.map((q) => <QuestionCard key={`${q.websiteId}:${q.key}`} q={q} showSite={showSite} />)}
      {rest > 0 && (moreHref
        ? <Link href={moreHref} className="block text-xs font-medium text-sky-700 hover:underline">+ {rest} more question{rest === 1 ? "" : "s"} →</Link>
        : <p className="text-xs text-slate-400">+ {rest} more after these.</p>)}
    </section>
  );
}
