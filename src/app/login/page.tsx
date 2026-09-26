"use client";

import { useActionState } from "react";
import { login, type LoginState } from "@/app/actions/auth";
import { BrandMark } from "@/components/brand";

export default function LoginPage() {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(login, undefined);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center">
          <BrandMark className="mb-3 h-14 w-14" />
          <h1 className="text-xl font-bold tracking-tight text-white">
            Bunker <span className="text-sky-500">Rank</span>
          </h1>
          <p className="mt-1 text-sm text-slate-400">Sign in to your workspace</p>
        </div>

        <form action={formAction} className="space-y-4 rounded-2xl border border-slate-700 bg-slate-800 p-6 shadow-xl">
          {state?.error && (
            <div className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-inset ring-rose-500/30">
              {state.error}
            </div>
          )}
          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium text-slate-300">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/30"
              placeholder="you@company.com"
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-slate-300">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/30"
              placeholder="••••••••"
            />
          </div>
          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-lg bg-sky-500 px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-sky-400 disabled:opacity-50"
          >
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
