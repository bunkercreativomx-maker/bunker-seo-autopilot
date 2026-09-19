"use client";

import { useActionState } from "react";
import { createWebsiteAction, updateWebsiteAction, type WebsiteActionState } from "@/app/actions/websites";
import { Field, Input, Select, Button } from "@/components/ui";
import type { Client, Website } from "@/lib/types";
import { PLATFORMS } from "@/lib/types";

export function WebsiteForm({ clients, website, defaultClientId }: { clients: Client[]; website?: Website; defaultClientId?: string }) {
  const action = website ? updateWebsiteAction : createWebsiteAction;
  const [state, formAction, pending] = useActionState<WebsiteActionState, FormData>(action, undefined);

  return (
    <form action={formAction} className="space-y-6">
      {website && <input type="hidden" name="id" value={website.id} />}
      {state?.error && (
        <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">{state.error}</div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Client *" error={state?.fieldErrors?.client?.[0]}>
          <Select name="client" defaultValue={website?.client ?? defaultClientId ?? ""} required>
            <option value="" disabled>
              Select a client…
            </option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.business_name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Website Name *" error={state?.fieldErrors?.name?.[0]}>
          <Input name="name" defaultValue={website?.name} required placeholder="Company Website" />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Domain *" error={state?.fieldErrors?.domain?.[0]}>
          <Input name="domain" defaultValue={website?.domain} required placeholder="example.com" />
        </Field>
        <Field label="Platform">
          <Select name="platform" defaultValue={website?.platform ?? "other"}>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Primary Language">
          <Input name="primary_language" defaultValue={website?.primary_language ?? ""} placeholder="en" />
        </Field>
        <Field label="Country">
          <Input name="country" defaultValue={website?.country ?? ""} placeholder="US" />
        </Field>
      </div>

      <Field label="Target Locations">
        <Input name="target_locations" defaultValue={website?.target_locations ?? ""} placeholder="El Paso, TX" />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Sitemap URL" error={state?.fieldErrors?.sitemap_url?.[0]}>
          <Input name="sitemap_url" defaultValue={website?.sitemap_url ?? ""} placeholder="https://example.com/sitemap.xml" />
        </Field>
        <Field label="Robots URL" error={state?.fieldErrors?.robots_url?.[0]}>
          <Input name="robots_url" defaultValue={website?.robots_url ?? ""} placeholder="https://example.com/robots.txt" />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Blog URL" error={state?.fieldErrors?.blog_url?.[0]}>
          <Input name="blog_url" defaultValue={website?.blog_url ?? ""} placeholder="https://example.com/blog" />
        </Field>
        <Field label="Status">
          <Select name="status" defaultValue={website?.status ?? "active"}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="archived">Archived</option>
          </Select>
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : website ? "Save Changes" : "Create Website"}
        </Button>
        <a
          href={website ? `/websites/${website.id}` : defaultClientId ? `/clients/${defaultClientId}` : "/websites"}
          className="text-sm font-medium text-slate-500 hover:text-slate-700"
        >
          Cancel
        </a>
      </div>
    </form>
  );
}
