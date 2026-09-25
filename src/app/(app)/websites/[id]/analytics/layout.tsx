import { AnalyticsTabs } from "@/components/analytics/analytics-tabs";

export default async function AnalyticsLayout({ params, children }: { params: Promise<{ id: string }>; children: React.ReactNode }) {
  const { id } = await params;
  return (
    <div>
      <AnalyticsTabs websiteId={id} />
      {children}
    </div>
  );
}
