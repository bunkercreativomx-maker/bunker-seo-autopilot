"use client";

import { useActionState } from "react";
import { saveBusinessContextAction, type StrategyActionState } from "@/app/actions/strategy";
import { Button, Field, Input, Textarea } from "@/components/ui";
import type { Client } from "@/lib/types";

const FIELDS: Array<{ name: keyof Client; label: string; multiline?: boolean }> = [
  { name: "industry", label: "Industry" },
  { name: "description", label: "Business description", multiline: true },
  { name: "primary_language", label: "Primary language" },
  { name: "secondary_languages", label: "Secondary languages" },
  { name: "country", label: "Country" },
  { name: "primary_location", label: "Primary location" },
  { name: "service_areas", label: "Service areas", multiline: true },
  { name: "target_audience", label: "Target audience", multiline: true },
  { name: "brand_voice", label: "Brand voice", multiline: true },
  { name: "services", label: "Services", multiline: true },
  { name: "products", label: "Products", multiline: true },
  { name: "unique_selling_proposition", label: "Unique selling proposition", multiline: true },
  { name: "primary_cta", label: "Primary CTA" },
];

export function BusinessContextForm({ websiteId, client, canEdit }: { websiteId: string; client: Client; canEdit: boolean }) {
  const [state, action, pending] = useActionState<StrategyActionState, FormData>(saveBusinessContextAction, undefined);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="websiteId" value={websiteId} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {FIELDS.map((field) => {
          const value = client[field.name];
          const stringValue = typeof value === "string" ? value : "";
          return (
            <Field key={field.name} label={field.label}>
              {field.multiline ? (
                <Textarea name={field.name} defaultValue={stringValue} rows={3} disabled={!canEdit} />
              ) : (
                <Input name={field.name} defaultValue={stringValue} disabled={!canEdit} />
              )}
            </Field>
          );
        })}
      </div>
      {state?.error && <p className="text-sm text-rose-600">{state.error}</p>}
      {state?.success && <p className="text-sm text-emerald-600">{state.success}</p>}
      {canEdit && <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save Business Context"}</Button>}
    </form>
  );
}
