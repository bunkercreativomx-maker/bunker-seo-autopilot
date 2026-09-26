"use client";

import { useActionState, useState } from "react";
import { quickAddWebsiteAction, type QuickAddState } from "@/app/actions/websites";

export function QuickAddWebsite({ clients, defaultClientId }: { clients: Array<{ id: string; business_name: string }>; defaultClientId?: string }) {
  const [state, action, pending] = useActionState<QuickAddState, FormData>(quickAddWebsiteAction, undefined);
  const [posts, setPosts] = useState(15);
  return (
    <form action={action} className="space-y-5">
      <div>
        <label htmlFor="url" className="text-sm font-medium text-slate-900">Website</label>
        <input
          id="url" name="url" required autoFocus inputMode="url" autoComplete="off" spellCheck={false}
          placeholder="tlalocsolfuturo.com"
          className="mt-1.5 block w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 shadow-sm outline-none placeholder:text-slate-400 focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15"
        />
      </div>

      <div>
        <p className="text-sm font-medium text-slate-900">Posts per month</p>
        <input type="hidden" name="posts" value={posts} />
        <div className="mt-1.5 inline-flex rounded-xl bg-slate-100 p-1">
          {[7, 15, 30].map((n) => (
            <button
              key={n} type="button" onClick={() => setPosts(n)}
              className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition ${posts === n ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {clients.length > 0 && (
        <details className="text-sm" open={Boolean(defaultClientId)}>
          <summary className="cursor-pointer text-slate-500">Add to an existing client (optional)</summary>
          <select name="client" defaultValue={defaultClientId ?? ""} className="mt-2 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="">New client (from the website)</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.business_name}</option>)}
          </select>
        </details>
      )}

      {state?.error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">{state.error}</p>}

      <button
        type="submit" disabled={pending}
        className="w-full rounded-xl bg-sky-600 px-4 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-sky-700 disabled:opacity-60"
      >
        {pending ? "Adding…" : "Add website"}
      </button>

      <ul className="space-y-1.5 text-xs text-slate-500">
        <li>✓ We read the site and learn the business: name, services, areas, phone, email.</li>
        <li>✓ We detect the site&apos;s language — posts are written in that language.</li>
        <li>✓ We only use what is written on the site (each fact keeps the exact quote and page).</li>
        <li>✓ Topics are picked automatically. You only approve posts.</li>
      </ul>
    </form>
  );
}
