import { notFound } from "next/navigation";
import { requireUser } from "@/lib/pocketbase/auth";
import { getClient } from "@/lib/pocketbase/clients";
import { ClientForm } from "@/components/client-form";
import { Card, CardHeader, CardBody, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function EditClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { pb } = await requireUser();
  const client = await getClient(pb, id);
  if (!client) notFound();

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={`Edit ${client.business_name}`} description="Update the client's business information." />
      <Card>
        <CardHeader title="Client Information" subtitle="Fields marked * are required." />
        <CardBody>
          <ClientForm client={client} />
        </CardBody>
      </Card>
    </div>
  );
}
