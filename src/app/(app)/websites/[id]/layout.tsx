import { notFound } from "next/navigation";
import { requireUser } from "@/lib/pocketbase/auth";
import { getWebsite } from "@/lib/pocketbase/websites";
import { PageHeader } from "@/components/ui";
import { WebsiteTabs } from "@/components/website-tabs";

export const dynamic = "force-dynamic";

/** Shared shell for all /websites/[id] tabs: header + navigation tabs. */
export default async function WebsiteLayout({
  params,
  children,
}: {
  params: Promise<{ id: string }>;
  children: React.ReactNode;
}) {
  const { id } = await params;
  const { pb } = await requireUser();
  const website = await getWebsite(pb, id);
  if (!website) notFound();

  return (
    <div>
      <PageHeader title={website.name} description={website.domain} />
      <WebsiteTabs websiteId={website.id} />
      <div className="py-5">{children}</div>
    </div>
  );
}