import { notFound } from "next/navigation";
import { requireUser } from "@/lib/pocketbase/auth";
import { listClients } from "@/lib/pocketbase/clients";
import { getClient } from "@/lib/pocketbase/clients";
import { WebsiteForm } from "@/components/website-form";
import { Card, CardHeader, CardBody, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function NewWebsiteForClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { pb } = await requireUser();
  const client = await getClient(pb, id);
  if (!client) notFound();
  const clients = await listClients(pb);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={`Add Website · ${client.business_name}`} description="Register a website for this client." />
      <Card>
        <CardHeader title="Website Information" subtitle="Fields marked * are required." />
        <CardBody>
          <WebsiteForm clients={clients} defaultClientId={client.id} />
        </CardBody>
      </Card>
    </div>
  );
}
