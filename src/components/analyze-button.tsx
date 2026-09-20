"use client";

import { useTransition } from "react";
import { analyzeWebsiteAction } from "@/app/actions/analysis";
import { Button } from "@/components/ui";

export function AnalyzeButton({ websiteId, hasAnalyzed }: { websiteId: string; hasAnalyzed: boolean }) {
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={() => {
        const formData = new FormData();
        formData.set("websiteId", websiteId);
        startTransition(() => {
          analyzeWebsiteAction(formData).catch(() => {});
        });
      }}
    >
      <Button type="submit" variant={hasAnalyzed ? "secondary" : "primary"} disabled={pending}>
        {pending ? "Starting…" : hasAnalyzed ? "Re-analyze Website" : "Analyze Website"}
      </Button>
    </form>
  );
}