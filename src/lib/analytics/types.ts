// Phase 6 — Search Console analytics types (server responses from
// /api/bsa/analytics/* and /api/bsa/gsc/*). Every metric comes from Google
// Search Console; nothing here is computed from invented data.

export type Metrics = { clicks: number; impressions: number; ctr: number; position: number | null; days?: number };
export type Change = { current: number | null; previous: number | null; abs: number | null; pct: number | null };
export type Comparison = { clicks: Change; impressions: Change; ctr: Change; position: Change };
export type Period = { range: string; start: string; end: string; days: number; prevStart: string; prevEnd: string };

export type PropertyInfo = {
  id: string; site_url: string; property_type: "domain" | "url_prefix"; permission_level: string; status: string; match_status: string;
  latest_final_date: string; first_data_date: string; last_synced_date: string; last_sync_at: string; last_sync_status: string;
  source_timezone: string; google_account_email: string; connection_status: string;
};

export type Summary = {
  connected: boolean; property: PropertyInfo | null; period: Period | null; hasData?: boolean; dataThrough?: string; source?: string; dataState?: string;
  totals?: Metrics; previousTotals?: Metrics; comparison?: Comparison; coverage?: { currentDays: number; previousDays: number };
  daily?: Array<{ date: string; clicks: number; impressions: number; ctr: number; position: number }>;
  counts?: { pages: number; queries: number; query_clicks: number; query_impressions: number };
  openOpportunities?: number;
  qualityFlags?: Array<{ id: string; start_date: string; end_date: string; reason: string; exclude_from_opportunities: boolean }>;
};

export type QueryRow = Metrics & { query: string; normalized_query: string; mapping: string; intent: string; brand: string; mapped_page: string; landing_page: string; previous: Metrics; change: Comparison };
export type PageMapping = { website_page?: { id: string; title: string; path: string }; article?: { id: string; title: string; status: string; published_at: string } | null; strategy_keywords?: string[] };
export type PageRow = Metrics & { page: string; previous: Metrics; change: Comparison; mapping: PageMapping };
export type Paged<T> = { connected: boolean; period: Period | null; dataThrough?: string; total?: number; page?: number; perPage?: number; rows: T[]; source?: string };

export type QueryDetail = {
  connected: boolean; period: Period | null; dataThrough?: string; query?: string; totals?: Metrics | null; previous?: Metrics; change?: Comparison | null;
  daily?: Array<{ date: string; clicks: number; impressions: number; ctr: number; position: number }>;
  landingPages?: Array<Metrics & { query: string; page: string; mapping: PageMapping }>;
  opportunities?: Array<{ id: string; type: string; status: string; priority: string }>;
};

export type ArticlePerformance = {
  published: boolean; publicUrl?: string; publishedAt?: string; publicationStatus?: string; daysLive?: number | null; connected?: boolean; hasData?: boolean;
  dataThrough?: string | null; sincePublication?: { start: string; end: string }; totals?: Metrics; topQueries?: Array<Metrics & { query: string; page: string }>;
};

export type ConnectionView = { id: string; google_account_email: string; scopes: string[]; status: string; last_refresh_at: string; last_error: string; created_at: string };
export type ConnectionInfo = {
  connections: ConnectionView[]; selected: PropertyInfo | null;
  oauth: { configured: boolean; testingMode: boolean; scopes: string[]; redirectUri: string }; canManage: boolean;
};
export type PropertyOption = {
  id: string; site_url: string; property_type: string; permission_level: string; status: string; selected: boolean; website: string;
  match_status: "matched" | "possible_match" | "mismatch"; mapped_to_this_website: boolean; connection: string; google_account_email: string; connection_status: string;
  latest_final_date: string; last_sync_at: string; last_sync_status: string;
};

export type SyncJob = {
  id: string; website: string; property: string; status: string; sync_type: string; range_label: string; start_date: string; end_date: string; step: string; progress: number;
  rows_requested: number; rows_received: number; rows_stored: number; api_requests: number; pagination_completed: boolean; warnings: Array<{ code: string; message: string }> | null;
  datasets: Record<string, unknown> | null; started_at: string; completed_at: string; error_code: string; error_message: string; created_at: string;
  expand?: { website?: { name: string } };
};

export type Opportunity = {
  id: string; website: string; client: string; type: string; query: string; page: string; current_period: Record<string, unknown> | null; previous_period: Record<string, unknown> | null;
  evidence: Record<string, unknown>; reason: string; priority: "high" | "medium" | "low"; recommended_action: string; status: "new" | "reviewed" | "accepted" | "ignored" | "resolved";
  source: string; first_detected_at: string; last_detected_at: string; resolved_at: string; detection_count: number; decided_at: string; decision_note: string; content_opportunity: string;
  expand?: { decided_by?: { name: string; email: string }; website?: { name: string } };
};

export type OrgOverview = {
  range: string; source: string; websitesConnected: number; websitesWithData: number; dataThrough: string | null;
  clicks: Change; impressions: Change; ctr: number; opportunities: number; growingPages: number; pagesLosingTraffic: number;
};
export type ClientOverview = {
  range: string; source: string;
  sites: Array<{ website: { id: string; name: string; domain: string }; connected: boolean; hasData?: boolean; property?: string; period?: Period; totals?: Metrics; comparison?: Comparison }>;
  aggregate: { clicks: number; impressions: number; ctr: number; weightedPosition: number | null };
};

export const OPPORTUNITY_LABELS: Record<string, string> = {
  new_query: "New query discovered",
  high_impressions_low_ctr: "High impressions / low CTR",
  striking_distance: "Striking distance",
  content_decay: "Content decay",
  growing_query: "Growing query",
  growing_page: "Growing page",
  position_decline: "Average position decline",
  impression_growth: "Impression growth",
  page_query_mismatch: "Page / query mismatch",
  optimization_candidate: "Optimization candidate",
  potential_cannibalization: "Potential query cannibalization",
};

export const MAPPING_LABELS: Record<string, string> = {
  known_keyword: "Known keyword",
  related_variant: "Related variant",
  new_query: "New query",
  unmapped: "Unmapped",
};

export const RANGE_OPTIONS = [
  { value: "7d", label: "Last 7 days" },
  { value: "28d", label: "Last 28 days" },
  { value: "3m", label: "Last 3 months" },
  { value: "6m", label: "Last 6 months" },
] as const;

export const SOURCE_LABEL = "Google Search Console";
export const ANONYMIZED_NOTE = "Search Console may omit anonymized or lower-volume queries. Query totals can be lower than site totals.";
