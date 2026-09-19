"use client";

import { useActionState } from "react";
import { createClientAction, updateClientAction, type ClientActionState } from "@/app/actions/clients";
import { Field, Input, Textarea, Select, Button } from "@/components/ui";
import type { Client } from "@/lib/types";

const FIELDS: Array<{ name: string; label: string; type?: "text" | "textarea" | "email" }> = [
  { name: "industry", label: "Industry" },
  { name: "description", label: "Description", type: "textarea" },
  { name: "primary_language", label: "Primary Language" },
  { name: "secondary_languages", label: "Secondary Languages" },
  { name: "country", label: "Country" },
  { name: "primary_location", label: "Primary Location" },
  { name: "service_areas", label: "Service Areas", type: "textarea" },
  { name: "target_audience", label: "Target Audience", type: "textarea" },
  { name: "brand_voice", label: "Brand Voice", type: "textarea" },
  { name: "services", label: "Services", type: "textarea" },
  { name: "products", label: "Products", type: "textarea" },
  { name: "unique_selling_proposition", label: "Unique Selling Proposition", type: "textarea" },
  { name: "primary_cta", label: "Primary CTA" },
  { name: "phone", label: "Phone" },
  { name: "email", label: "Email", type: "email" },
];

function fieldValue(client: Client | undefined, name: string): string {
  if (!client) return "";
  const v = (client as unknown as Record<string, unknown>)[name];
  return typeof v === "string" ? v : "";
}

export function ClientForm({ client }: { client?: Client }) {
  const action = client ? updateClientAction : createClientAction;
  const [state, formAction, pending] = useActionState<ClientActionState, FormData>(action, undefined);

  return (
    <form action={formAction} className="space-y-6">
      {client && <input type="hidden" name="id" value={client.id} />}
      {state?.error && (
        <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">{state.error}</div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Business Name *" error={state?.fieldErrors?.business_name?.[0]}>
          <Input name="business_name" defaultValue={client?.business_name} required placeholder="Acme Inc." />
        </Field>
        <Field label="Status">
          <Select name="status" defaultValue={client?.status ?? "active"}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="archived">Archived</option>
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <Field key={f.name} label={f.label} error={state?.fieldErrors?.[f.name]?.[0]}>
            {f.type === "textarea" ? (
              <Textarea name={f.name} defaultValue={fieldValue(client, f.name)} rows={3} />
            ) : (
              <Input name={f.name} type={f.type ?? "text"} defaultValue={fieldValue(client, f.name)} />
            )}
          </Field>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : client ? "Save Changes" : "Create Client"}
        </Button>
        <a href={client ? `/clients/${client.id}` : "/clients"} className="text-sm font-medium text-slate-500 hover:text-slate-700">
          Cancel
        </a>
      </div>
    </form>
  );
}
