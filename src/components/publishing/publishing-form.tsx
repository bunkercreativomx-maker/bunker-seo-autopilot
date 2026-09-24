"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { PublishingActionState } from "@/app/actions/publishing";
import { Button } from "@/components/ui";

type Action = (prev: PublishingActionState, formData: FormData) => Promise<PublishingActionState>;

/** Form bound to a publishing server action. A one-time secret is displayed once and never stored client-side. */
export function PublishingForm({
  action, hidden, children, submitLabel, pendingLabel = "Working…", variant = "primary", className,
}: {
  action: Action;
  hidden: Record<string, string | number>;
  children?: React.ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  className?: string;
}) {
  const [state, formAction, pending] = useActionState<PublishingActionState, FormData>(action, undefined);
  const router = useRouter();
  useEffect(() => {
    if (state?.success) router.refresh();
  }, [state, router]);
  return (
    <form action={formAction} className={className}>
      {Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={String(value)} />)}
      {children}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="submit" variant={variant} disabled={pending}>{pending ? pendingLabel : submitLabel}</Button>
        {state?.error && <span className="text-xs text-rose-600">{state.code ? `${state.code}: ` : ""}{state.error}</span>}
        {state?.success && <span className="text-xs text-emerald-700">{state.success}</span>}
      </div>
      {state?.secret && (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <p className="font-semibold">Copy this secret now — it will not be shown again.</p>
          <p className="mt-1">Set it on the target website as <code>BUNKER_PUBLISH_SECRET</code>.</p>
          <input readOnly value={state.secret} className="mt-2 w-full rounded border border-amber-300 bg-white px-2 py-1 font-mono" onFocus={(e) => e.currentTarget.select()} />
        </div>
      )}
    </form>
  );
}
