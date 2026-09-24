"use client";

import { useActionState } from "react";
import { startGenerationAction, type ContentActionState } from "@/app/actions/content";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { CONTENT_TYPE_LABELS, type ContentTypeKey } from "@/lib/content/types";

export function GenerateContentForm({
  websiteId, sourceKind, sourceId, defaults,
}: {
  websiteId: string;
  sourceKind: "opportunity" | "plan_item";
  sourceId: string;
  defaults: { content_type: string; primary_keyword: string; target_location: string; recommended_url: string; reason: string; language: string };
}) {
  const [state, action, pending] = useActionState<ContentActionState, FormData>(startGenerationAction, undefined);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="websiteId" value={websiteId} />
      <input type="hidden" name="sourceKind" value={sourceKind} />
      <input type="hidden" name="sourceId" value={sourceId} />
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Content type">
          <Select name="content_type" defaultValue={defaults.content_type}>
            {(Object.keys(CONTENT_TYPE_LABELS) as ContentTypeKey[]).map((key) => <option key={key} value={key}>{CONTENT_TYPE_LABELS[key]}</option>)}
          </Select>
        </Field>
        <Field label="Primary keyword"><Input name="primary_keyword" defaultValue={defaults.primary_keyword} required minLength={2} maxLength={200} /></Field>
        <Field label="Target location (required for location pages)"><Input name="target_location" defaultValue={defaults.target_location} maxLength={200} /></Field>
        <Field label="Recommended URL"><Input name="recommended_url" defaultValue={defaults.recommended_url} maxLength={500} placeholder="/blog/..." /></Field>
        <Field label="Language (ISO)"><Input name="language" defaultValue={defaults.language} required maxLength={10} /></Field>
      </div>
      <Field label="Reason"><Textarea name="reason" defaultValue={defaults.reason} rows={3} maxLength={1500} /></Field>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" name="pause_after_brief" className="h-4 w-4 rounded border-slate-300" />
        Pause after the brief so I can edit it before drafting
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>{pending ? "Starting…" : "Generate Content"}</Button>
        {state?.error && <span className="text-sm text-rose-600">{state.error}</span>}
      </div>
      <p className="text-xs text-slate-500">Generation runs in the background worker (not in this request). Nothing is published: Phase 4 ends at an approved draft.</p>
    </form>
  );
}
