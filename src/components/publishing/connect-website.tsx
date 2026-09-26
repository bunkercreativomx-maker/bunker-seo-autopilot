"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { verifyConnectionAction, disconnectAction, type ConnectState } from "@/app/actions/connect";

type Platform = "vercel" | "wordpress" | "other";

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button type="button" variant="secondary" onClick={async () => { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}>
      {done ? "Copied ✓" : "Copy"}
    </Button>
  );
}

function Step({ n, title, children }: { n: number; title: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-orange-500 text-xs font-bold text-white">{n}</span>
      <div className="min-w-0 flex-1 space-y-2 text-sm"><p className="font-medium text-slate-800">{title}</p>{children}</div>
    </li>
  );
}

export function ConnectWebsite({ websiteId, domain, snippet, rewriteLines, connected, lastError, admin }: {
  websiteId: string; domain: string; snippet: string; rewriteLines: string; connected: boolean; lastError?: string; admin: boolean;
}) {
  const [platform, setPlatform] = useState<Platform>("vercel");
  const [state, verify, pending] = useActionState<ConnectState, FormData>(verifyConnectionAction, undefined);
  const [, disconnect, disconnecting] = useActionState<ConnectState, FormData>(disconnectAction, undefined);
  const router = useRouter();
  const isConnected = state?.connected ?? connected;
  useEffect(() => { if (state?.connected) router.refresh(); }, [state, router]);

  if (isConnected) {
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-base font-semibold text-emerald-800">✓ Connected</p>
          <p className="mt-1 text-sm text-emerald-900">Approved posts are published at <a className="font-medium underline" href={`https://${domain}/blog`} target="_blank" rel="noopener noreferrer">{domain}/blog</a> and indexed by Google as part of the website.</p>
        </div>
        {admin && <form action={disconnect}><input type="hidden" name="websiteId" value={websiteId} /><Button variant="ghost" disabled={disconnecting}>{disconnecting ? "…" : "Disconnect"}</Button></form>}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2 text-sm text-slate-600">Where is <strong>{domain}</strong> hosted?</p>
        <div className="flex flex-wrap gap-2">
          {([["vercel", "Vercel (Next.js, React, Vite)"], ["wordpress", "WordPress"], ["other", "Other (Wix, Shopify…)"]] as const).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setPlatform(k)}
              className={`rounded-lg px-3 py-1.5 text-sm ring-1 ring-inset ${platform === k ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"}`}>{label}</button>
          ))}
        </div>
      </div>

      {platform === "vercel" && (
        <ol className="space-y-5">
          <Step n={1} title="In the website's GitHub repo, open vercel.json (create it in the root if it doesn't exist).">
            <p className="text-xs text-slate-500">No vercel.json yet? Paste this whole file:</p>
            <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{snippet}</pre>
            <Copy text={snippet} />
            <p className="pt-2 text-xs text-slate-500">Already has one with <code>&quot;rewrites&quot;</code>? Paste these two lines as the <strong>first</strong> items inside <code>&quot;rewrites&quot;: [</code> (before any <code>/(.*)</code> rule):</p>
            <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{rewriteLines}</pre>
            <Copy text={rewriteLines} />
          </Step>
          <Step n={2} title="Commit. Vercel deploys by itself (1–2 min)." />
          <Step n={3} title={`Press Verify — we check ${domain}/blog and go live.`}>
            <form action={verify} className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="websiteId" value={websiteId} />
              <Button disabled={pending || !admin}>{pending ? "Checking…" : "Verify"}</Button>
              {!admin && <span className="text-xs text-slate-500">Only admins can connect.</span>}
            </form>
            {(state?.reason || state?.error || (!state && lastError)) && (
              <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">Not connected yet: {state?.reason || state?.error || lastError}</p>
            )}
          </Step>
        </ol>
      )}

      {platform === "wordpress" && (
        <ol className="space-y-4">
          <Step n={1} title="In WordPress: Users → Profile → Application Passwords → name it “Bunker Rank” → Add. Copy the password." />
          <Step n={2} title="Open Advanced settings below: Publisher = WordPress, API endpoint = https://your-site.com/wp-json/wp/v2, your WordPress username, then paste the password in “Publisher secret”." />
          <Step n={3} title="Press Test Connection." />
        </ol>
      )}

      {platform === "other" && (
        <p className="text-sm text-slate-600">Wix, Shopify and Squarespace can&apos;t proxy /blog. Easiest option: create a subdomain <strong>blog.{domain.replace(/^www\./, "")}</strong> pointing to Bunker Rank — ask us and we set it up.</p>
      )}
    </div>
  );
}
