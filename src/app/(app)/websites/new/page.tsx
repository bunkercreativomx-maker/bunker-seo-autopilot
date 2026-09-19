import { requireUser } from "@/lib/pocketbase/auth";
import { listClients } from "@/lib/pocketbase/clients";
import { WebsiteForm } from "@/components/website-form";
import { Card, CardHeader, CardBody, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function NewWebsitePage({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  const { pb } = await requireUser();
  const clients = await listClients(pb);
  const { client } = await searchParams;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Add Website" description="Register a website for a client." />
      <Card>
        <CardHeader title="Website Information" subtitle="Fields marked * are required." />
        <CardBody>
          <WebsiteForm clients={clients} defaultClientId={client} />
        </CardBody>
      </Card>
    </div>
  );
}
