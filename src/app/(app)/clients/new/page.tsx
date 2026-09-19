import { requireUser } from "@/lib/pocketbase/auth";
import { ClientForm } from "@/components/client-form";
import { Card, CardHeader, CardBody, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function NewClientPage() {
  await requireUser();
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Add Client" description="Create a new client to start building their SEO presence." />
      <Card>
        <CardHeader title="Client Information" subtitle="Fields marked * are required." />
        <CardBody>
          <ClientForm />
        </CardBody>
      </Card>
    </div>
  );
}
