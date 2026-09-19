"use client";

import { useActionState } from "react";
import { updateProfileAction, updateOrganizationAction, type SettingsState } from "@/app/actions/settings";
import { Field, Input, Button } from "@/components/ui";

export function ProfileForm({ name, email, role }: { name: string; email: string; role: string }) {
  const [state, formAction, pending] = useActionState<SettingsState, FormData>(updateProfileAction, undefined);
  return (
    <form action={formAction} className="space-y-4">
      {state?.error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">{state.error}</div>}
      {state?.success && <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 ring-1 ring-inset ring-emerald-200">{state.success}</div>}
      <Field label="Name">
        <Input name="name" defaultValue={name} required />
      </Field>
      <Field label="Email">
        <Input value={email} disabled />
      </Field>
      <Field label="Role">
        <Input value={role} disabled />
      </Field>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save Profile"}
      </Button>
    </form>
  );
}

export function OrganizationForm({ name }: { name: string }) {
  const [state, formAction, pending] = useActionState<SettingsState, FormData>(updateOrganizationAction, undefined);
  return (
    <form action={formAction} className="space-y-4">
      {state?.error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">{state.error}</div>}
      {state?.success && <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 ring-1 ring-inset ring-emerald-200">{state.success}</div>}
      <Field label="Organization Name">
        <Input name="name" defaultValue={name} required />
      </Field>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save Organization"}
      </Button>
    </form>
  );
}
