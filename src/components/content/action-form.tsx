"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { ContentActionState } from "@/app/actions/content";
import { Button } from "@/components/ui";

type Action = (prev: ContentActionState, formData: FormData) => Promise<ContentActionState>;

/** Generic form bound to a content server action, with inline success/error. */
export function ActionForm({
  action, hidden, children, submitLabel, pendingLabel = "Working…", variant = "primary", className, confirm,
}: {
  action: Action;
  hidden: Record<string, string | number>;
  children?: React.ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  className?: string;
  confirm?: string;
}) {
  const [state, formAction, pending] = useActionState<ContentActionState, FormData>(action, undefined);
  const router = useRouter();
  useEffect(() => {
    if (state?.success) router.refresh();
  }, [state, router]);
  return (
    <form
      action={formAction}
      className={className}
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
    >
      {Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={String(value)} />)}
      {children}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button type="submit" variant={variant} disabled={pending}>{pending ? pendingLabel : submitLabel}</Button>
        {state?.error && <span className="text-xs text-rose-600">{state.error}</span>}
        {state?.success && <span className="text-xs text-emerald-700">{state.success}</span>}
      </div>
    </form>
  );
}
