// Shared domain types, kept consistent with the PocketBase schema.

export type OrgStatus = "active" | "inactive";
export type ClientStatus = "active" | "inactive" | "archived";
export type WebsiteStatus = "active" | "inactive" | "archived";
export type UserRole = "super_admin" | "admin" | "client" | "editor" | "viewer";
export type UserStatus = "active" | "disabled";
export type WebsitePlatform = "nextjs" | "react" | "wordpress" | "custom" | "other";

export type ActivityAction =
  | "USER_LOGIN"
  | "USER_LOGOUT"
  | "CLIENT_CREATED"
  | "CLIENT_UPDATED"
  | "CLIENT_ARCHIVED"
  | "WEBSITE_CREATED"
  | "WEBSITE_UPDATED"
  | "WEBSITE_ARCHIVED"
  | "WEBSITE_ANALYSIS_STARTED";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: OrgStatus;
  created: string;
  updated: string;
  created_at?: string;
}

export interface User {
  id: string;
  email: string;
  name?: string;
  organization?: string; // relation id
  role: UserRole;
  status: UserStatus;
  created: string;
  updated: string;
}

export interface Client {
  id: string;
  organization: string;
  business_name: string;
  slug: string;
  industry?: string;
  description?: string;
  primary_language?: string;
  secondary_languages?: string;
  country?: string;
  primary_location?: string;
  service_areas?: string;
  target_audience?: string;
  brand_voice?: string;
  services?: string;
  products?: string;
  unique_selling_proposition?: string;
  primary_cta?: string;
  phone?: string;
  email?: string;
  status: ClientStatus;
  created: string;
  updated: string;
  created_at?: string;
}

export interface Website {
  id: string;
  organization: string;
  client: string;
  name: string;
  domain: string;
  platform: WebsitePlatform;
  primary_language?: string;
  country?: string;
  target_locations?: string;
  sitemap_url?: string;
  robots_url?: string;
  blog_url?: string;
  status: WebsiteStatus;
  created: string;
  updated: string;
  created_at?: string;
}

export interface ActivityLog {
  id: string;
  organization: string;
  user?: string;
  client?: string;
  website?: string;
  action: ActivityAction;
  entity_type?: string;
  entity_id?: string;
  metadata?: Record<string, unknown>;
  created: string;
  created_at?: string;
}

// Expanded records (PocketBase returns relation objects when expanded).
export interface ClientExpanded extends Client {
  expand?: { organization?: Organization };
}
export interface WebsiteExpanded extends Website {
  expand?: { organization?: Organization; client?: Client };
}
export interface ActivityLogExpanded extends ActivityLog {
  expand?: { user?: User; client?: Client; website?: Website };
}

// ---------- Phase 2: Website Intelligence ----------

export type CrawlStatus = "queued" | "running" | "completed" | "completed_with_errors" | "failed" | "cancelled";
export type IssueSeverity = "critical" | "high" | "medium" | "low" | "opportunity";
export type IssueStatus = "open" | "ignored" | "resolved";

export interface CrawlJob {
  id: string;
  organization: string;
  client: string;
  website: string;
  status: CrawlStatus;
  started_at?: string;
  completed_at?: string;
  pages_discovered?: number;
  pages_crawled?: number;
  pages_failed?: number;
  errors_count?: number;
  triggered_by?: string;
  configuration?: Record<string, unknown>;
  error_message?: string;
  created: string;
  updated: string;
  created_at?: string;
}

export interface WebsitePage {
  id: string;
  organization: string;
  client: string;
  website: string;
  url: string;
  normalized_url: string;
  path?: string;
  status_code?: number;
  content_type?: string;
  indexable?: boolean;
  indexability_reason?: string;
  canonical_url?: string;
  title?: string;
  title_length?: number;
  meta_description?: string;
  meta_description_length?: number;
  h1?: string;
  h1_count?: number;
  headings?: Record<string, string[]>;
  word_count?: number;
  language?: string;
  robots_directives?: string[];
  schema_types?: string[];
  internal_links_count?: number;
  external_links_count?: number;
  images_count?: number;
  images_missing_alt?: number;
  content_hash?: string;
  crawl_depth?: number;
  last_crawled_at?: string;
  created: string;
  updated: string;
  created_at?: string;
}

export interface SeoIssue {
  id: string;
  organization: string;
  client: string;
  website: string;
  page?: string;
  category?: string;
  severity: IssueSeverity;
  issue_type: string;
  title?: string;
  description?: string;
  evidence?: Record<string, unknown>;
  recommended_action?: string;
  status: IssueStatus;
  first_detected_at?: string;
  last_detected_at?: string;
  resolved_at?: string;
  created: string;
  updated: string;
  created_at?: string;
  expand?: { page?: WebsitePage };
}

export interface WebsiteSnapshot {
  id: string;
  organization: string;
  client: string;
  website: string;
  crawl_job?: string;
  total_pages?: number;
  indexable_pages?: number;
  non_indexable_pages?: number;
  broken_pages?: number;
  total_issues?: number;
  critical_issues?: number;
  high_issues?: number;
  medium_issues?: number;
  low_issues?: number;
  opportunities?: number;
  created: string;
  updated: string;
  created_at?: string;
}

export interface PageLink {
  id: string;
  organization: string;
  client: string;
  website: string;
  source_page: string;
  destination_url: string;
  destination_page?: string;
  anchor_text?: string;
  link_type: "internal" | "external";
  status_code?: number;
  created: string;
  created_at?: string;
}

export interface WebsiteChange {
  id: string;
  organization: string;
  client: string;
  website: string;
  page?: string;
  change_type: string;
  old_value?: string;
  new_value?: string;
  detected_at?: string;
  crawl_job?: string;
  created: string;
  created_at?: string;
}

export type WebsiteHealth = "healthy" | "needs_attention" | "critical" | "not_analyzed";

// ---------- Phase 3: SEO Strategy ----------

export type StrategyJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type StrategyRecordStatus = "discovered" | "draft" | "open" | "proposed" | "planned" | "reviewed" | "approved" | "targeted" | "ignored" | "resolved" | "archived" | "skipped" | "in_progress" | "completed";
export type SearchIntent = "informational" | "navigational" | "commercial" | "transactional" | "local" | "mixed";
export type StrategyPriority = "critical" | "high" | "medium" | "low";
export type PlanHorizon = "30" | "60" | "90";
export type PlanItemStatus = "planned" | "approved" | "in_progress" | "completed" | "skipped";

interface StrategyRecordBase {
  id: string;
  organization: string;
  client: string;
  website: string;
  strategy_version?: string;
  manual_override?: boolean;
  manual_fields?: string[];
  overridden_by?: string;
  overridden_at?: string;
  created: string;
  updated: string;
  created_at?: string;
  updated_at?: string;
}

export interface StrategyJob extends Omit<StrategyRecordBase, "strategy_version"> {
  status: StrategyJobStatus;
  step?: string;
  progress?: number;
  error?: string;
  triggered_by?: string;
  configuration?: Record<string, unknown>;
  started_at?: string;
  completed_at?: string;
}

export interface StrategyVersion extends Omit<StrategyRecordBase, "strategy_version"> {
  strategy_job?: string;
  version: number;
  summary?: string;
  generated_at: string;
  generated_by?: string;
  configuration?: Record<string, unknown>;
}

export interface StrategyKeyword extends StrategyRecordBase {
  keyword: string;
  normalized_keyword?: string;
  language?: string;
  country?: string;
  target_location?: string;
  intent?: SearchIntent | string;
  intent_confidence?: number | null;
  funnel_stage?: string;
  topic?: string;
  source?: string;
  source_query?: string;
  existing_target_page?: string;
  recommended_target_page?: string;
  cluster?: string;
  opportunity_type?: string;
  recommended_page_type?: string;
  priority?: StrategyPriority | string;
  status?: StrategyRecordStatus;
  search_volume?: number | null;
  keyword_difficulty?: number | null;
  cpc?: number | null;
  metrics_source?: string;
  confidence?: number | null;
  evidence?: unknown;
  expand?: { cluster?: TopicCluster };
}

export interface TopicCluster extends StrategyRecordBase {
  name: string;
  description?: string;
  primary_topic?: string;
  pillar_keyword?: string;
  pillar_page?: string;
  status?: StrategyRecordStatus;
  confidence?: number | null;
  evidence?: unknown;
  keyword_count?: number | null;
  intent?: SearchIntent | string;
  expand?: { pillar_keyword?: StrategyKeyword; pillar_page?: WebsitePage };
}

export interface ContentOpportunity extends StrategyRecordBase {
  keyword?: string;
  cluster?: string;
  opportunity_type?: string;
  recommended_page_type?: string;
  existing_page?: string;
  recommended_url?: string;
  title_suggestion?: string;
  reason?: string;
  priority?: StrategyPriority | string;
  status?: StrategyRecordStatus;
  evidence?: unknown;
  confidence?: number | null;
  expand?: { keyword?: StrategyKeyword; cluster?: TopicCluster; existing_page?: WebsitePage };
}

export interface CannibalizationIssue extends StrategyRecordBase {
  keyword_group: string;
  pages?: string[];
  reason?: string;
  severity?: StrategyPriority | string;
  recommended_action?: string;
  status?: StrategyRecordStatus;
  confidence?: number | null;
  evidence?: unknown;
  expand?: { pages?: WebsitePage[] };
}

export interface InternalLinkOpportunity extends ContentOpportunity {
  source_page?: string;
  source_url?: string;
  target_page?: string;
  target_url?: string;
  anchor_text?: string;
}

export interface StrategyPlanItem extends StrategyRecordBase {
  plan?: string;
  opportunity?: string;
  keyword?: string;
  cluster?: string;
  action?: string;
  page_type?: string;
  existing_page?: string;
  proposed_url?: string;
  proposed_title?: string;
  priority?: StrategyPriority | string;
  scheduled_period?: string;
  status?: PlanItemStatus;
  reason?: string;
  evidence?: unknown;
  expand?: { keyword?: StrategyKeyword; cluster?: TopicCluster; existing_page?: WebsitePage; opportunity?: ContentOpportunity };
}

export interface StrategyData {
  latestJob: StrategyJob | null;
  keywords: StrategyKeyword[];
  clusters: TopicCluster[];
  opportunities: ContentOpportunity[];
  cannibalization: CannibalizationIssue[];
  internalLinks: InternalLinkOpportunity[];
  plan: StrategyPlanItem[];
}

export type FactProvenance =
  | "user_provided" | "website" | "crawler" | "manual" | "external_source" | "ai_inferred" | "unknown";
export type VerificationState = "unverified" | "verified" | "ai_inferred" | "user_confirmed" | "unknown";

export interface BusinessFact extends StrategyRecordBase {
  fact_type: string;
  label: string;
  value: string;
  source?: string;
  source_url?: string;
  verified?: boolean;
  provenance?: FactProvenance;
  verification_state?: VerificationState;
  verified_by?: string;
  verified_at?: string;
}

// Human-readable labels for internal page-type enums. Internal enum values stay
// stable (no migration); only the UI label changes.
export const PAGE_TYPE_LABELS: Record<string, string> = {
  service_page: "Service Page",
  location_page: "Location Page",
  blog_article: "Blog Article",
  comparison: "Comparison Page",
  guide: "Guide",
  faq: "FAQ Page",
  product_page: "Product Page",
  category_page: "Category Page",
  homepage: "Homepage",
  existing_page: "Existing Page Optimization",
  technical: "Technical Fix",
  other: "Other",
  service: "Service Page",
  location: "Location Page",
  article: "Blog Article",
  product: "Product Page",
  utility: "Utility Page",
};

export const OPPORTUNITY_LABELS: Record<string, string> = {
  create: "Create New Page",
  optimize: "Optimize Existing Page",
  expand: "Expand Existing Page",
  merge: "Merge Pages",
  internal_link: "Add Internal Link",
  location: "Create Location Page",
  service: "Create Service Page",
  refresh: "Refresh / Optimize",
  ignore: "Ignore",
};

export const INTENT_LABELS: Record<string, string> = {
  informational: "Informational",
  commercial: "Commercial",
  transactional: "Transactional",
  navigational: "Navigational",
  local: "Local",
  mixed: "Mixed",
};

export function pageTypeLabel(value?: string | null): string {
  return (value && PAGE_TYPE_LABELS[value]) || value || "Other";
}

export function opportunityLabel(value?: string | null): string {
  return (value && OPPORTUNITY_LABELS[value]) || value || "Other";
}

export function intentLabel(value?: string | null): string {
  return (value && INTENT_LABELS[value]) || value || "Unknown";
}

export const PLATFORMS: WebsitePlatform[] = ["nextjs", "react", "wordpress", "custom", "other"];
export const CRAWL_STATUSES: CrawlStatus[] = ["queued", "running", "completed", "completed_with_errors", "failed", "cancelled"];
export const ISSUE_SEVERITIES: IssueSeverity[] = ["critical", "high", "medium", "low", "opportunity"];
export const CLIENT_STATUSES: ClientStatus[] = ["active", "inactive", "archived"];
export const WEBSITE_STATUSES: WebsiteStatus[] = ["active", "inactive", "archived"];
export const USER_ROLES: UserRole[] = ["super_admin", "admin", "client", "editor", "viewer"];

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Normalize a domain to a canonical form: strip protocol, path, trailing slash. */
export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/^www\./, "");
  d = d.split("/")[0].split("?")[0].split("#")[0];
  return d;
}

/** Normalize a URL to absolute https form (used for sitemap/robots/blog). */
export function normalizeUrl(input: string): string {
  const t = input.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

export function isValidDomain(input: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(input.trim());
}

export function isValidUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
