import { requireUser } from "@/lib/pocketbase/auth";
import { createBaseClient } from "@/lib/pocketbase/client";
import { Card, CardHeader, CardBody, PageHeader } from "@/components/ui";
import { ProfileForm, OrganizationForm } from "@/components/settings-forms";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { user } = await requireUser();

  let orgName = "";
  if (user.organization) {
    try {
      const pb = createBaseClient();
      const org = await pb.collection("organizations").getOne(user.organization);
      orgName = (org as { name?: string }).name ?? "";
    } catch {
      // ignore
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Settings" description="Manage your organization and profile." />
      <div className="space-y-6">
        <Card>
          <CardHeader title="Organization Settings" subtitle="Basic organization information." />
          <CardBody>
            <OrganizationForm name={orgName} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="User Profile" subtitle="Your account details." />
          <CardBody>
            <ProfileForm name={user.name ?? ""} email={user.email} role={user.role} />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
