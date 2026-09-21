"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { queueStrategyAction, type StrategyActionState } from "@/app/actions/strategy";
import { Button } from "@/components/ui";

export function StrategyGenerateButton({
  websiteId,
  hasStrategy,
  disabled = false,
}: {
  websiteId: string;
  hasStrategy: boolean;
  disabled?: boolean;
}) {
  const [state, action, pending] = useActionState<StrategyActionState, FormData>(queueStrategyAction, undefined);
  const router = useRouter();

  useEffect(() => {
    if (state?.jobId) router.refresh();
  }, [state?.jobId, router]);

  return (
    <div className="text-right">
      <form action={action}>
        <input type="hidden" name="websiteId" value={websiteId} />
        <input type="hidden" name="regenerate" value={hasStrategy ? "true" : "false"} />
        <Button type="submit" disabled={disabled || pending}>
          {pending ? "Queueing…" : hasStrategy ? "Regenerate Strategy" : "Generate Strategy"}
        </Button>
      </form>
      {state?.error && <p className="mt-1 max-w-xs text-xs text-rose-600">{state.error}</p>}
      {state?.success && <p className="mt-1 text-xs text-emerald-600">{state.success}</p>}
    </div>
  );
}
