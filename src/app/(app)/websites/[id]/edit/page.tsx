import { notFound } from "next/navigation";
import { requireUser } from "@/lib/pocketbase/auth";
import { getWebsite } from "@/lib/pocketbase/websites";
import { listClients } from "@/lib/pocketbase/clients";
import { WebsiteForm } from "@/components/website-form";
import { Card, CardHeader, CardBody, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function EditWebsitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { pb } = await requireUser();
  const website = await getWebsite(pb, id);
  if (!website) notFound();
  const clients = await listClients(pb);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={`Edit ${website.name}`} description="Update the website's information." />
      <Card>
        <CardHeader title="Website Information" subtitle="Fields marked * are required." />
        <CardBody>
          <WebsiteForm clients={clients} website={website} />
        </CardBody>
      </Card>
    </div>
  );
}
