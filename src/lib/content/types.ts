// Phase 4 content engine record shapes (read side).
export type ArticleStatus =
  | "researching" | "brief_ready" | "outline_ready" | "drafting" | "draft" | "qa"
  | "needs_revision" | "awaiting_approval" | "approved" | "rejected" | "failed";

export type ContentTypeKey = "blog_article" | "service_page" | "location_page" | "guide" | "comparison" | "faq_page" | "existing_page_optimization";

export interface Article {
  id: string;
  organization: string;
  client: string;
  website: string;
  content_opportunity?: string;
  content_plan_item?: string;
  keyword?: string;
  cluster?: string;
  existing_page?: string;
  content_type: ContentTypeKey;
  title?: string;
  slug?: string;
  excerpt?: string;
  seo_title?: string;
  meta_description?: string;
  og_title?: string;
  og_description?: string;
  content?: string;
  content_format?: string;
  existing_content?: string;
  status: ArticleStatus;
  primary_keyword?: string;
  secondary_keywords?: string[] | null;
  target_location?: string;
  recommended_url?: string;
  featured_image?: string;
  canonical_url?: string;
  author?: string;
  language: string;
  research?: string;
  brief?: Record<string, unknown> | null;
  outline?: { h1?: string; sections?: Array<{ level: number; heading: string; purpose: string; evidence_ids: string[]; internal_link_ids: string[]; cta: boolean }>; faq?: Array<{ question: string; evidence_ids: string[] }>; cta_placement?: string } | null;
  structured_data?: Array<{ type: string; reason: string; jsonld: unknown }> | null;
  qa_status?: "pending" | "PASS" | "NEEDS_REVISION" | "BLOCKED" | "stale";
  qa_score?: number | null;
  qa_summary?: string;
  fact_check_status?: "pending" | "passed" | "issues" | "blocked" | "stale";
  flags?: string[] | null;
  high_risk?: boolean;
  risk_categories?: string[] | null;
  revision_cycles?: number;
  current_version?: number;
  generation_key?: string;
  generation_input?: Record<string, unknown> | null;
  provenance?: Record<string, unknown> | null;
  pipeline_state?: Record<string, unknown> | null;
  approved_by?: string;
  approved_at?: string;
  rejected_by?: string;
  rejected_at?: string;
  rejection_reason?: string;
  created_by?: string;
  created: string;
  updated: string;
  expand?: { client?: { business_name: string }; website?: { name: string; domain: string }; approved_by?: { name?: string; email: string } };
}

export interface ArticleVersion {
  id: string;
  article: string;
  version: number;
  title?: string;
  content?: string;
  seo_title?: string;
  meta_description?: string;
  excerpt?: string;
  slug?: string;
  change_type: "ai_generation" | "ai_revision" | "manual_edit" | "restore";
  change_reason?: string;
  created_by?: string;
  created_by_label?: string;
  created: string;
}

export interface ContentJob {
  id: string;
  organization: string;
  article: string;
  mode: "generate" | "continue" | "revision" | "recheck";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  step?: string;
  progress?: number;
  error?: string;
  error_code?: string;
  revision_instruction?: string;
  started_at?: string;
  completed_at?: string;
  created: string;
}

export interface ResearchSource {
  id: string;
  url: string;
  title?: string;
  publisher?: string;
  source_type: string;
  retrieved_at?: string;
  relevance?: number;
  quality?: number;
  notes?: string;
  excerpt?: string;
  query?: string;
  verified_access?: boolean;
  http_status?: number;
  provider?: string;
}

export interface ArticleResearch {
  id: string;
  search_intent?: string;
  audience?: string;
  questions?: string[];
  facts?: Array<{ fact: string; availability: string; evidence_ids: string[] }>;
  source_ids?: string[];
  existing_content_summary?: string;
  internal_link_candidates?: Array<{ candidate_id: string; reason: string; url?: string; title?: string }>;
  risks?: { items?: string[]; categories?: string[]; claims_requiring_sources?: string[]; time_sensitive?: boolean; sufficiency?: string; sufficiency_reason?: string } | null;
  do_not_claim?: string[];
  content_gaps?: string[];
  recommended_angle?: string;
  research_status?: "completed" | "limited" | "research_required";
  research_notes?: string;
}

export interface ArticleClaim {
  id: string;
  version: number;
  claim: string;
  claim_type: string;
  source?: string;
  source_id?: string;
  evidence_ids?: Array<{ ref: string; record: string }>;
  verification_status: "PENDING" | "VERIFIED" | "SUPPORTED" | "UNVERIFIED" | "CONTRADICTED" | "NOT_REQUIRED";
  risk_level: "low" | "medium" | "high";
  action?: string;
  notes?: string;
}

export interface ArticleInternalLink {
  id: string;
  version: number;
  destination_page?: string;
  destination_url: string;
  anchor_text?: string;
  reason?: string;
  status: "inserted" | "recommended" | "removed";
}

export interface ArticleQaReport {
  id: string;
  version: number;
  cycle: number;
  status: "PASS" | "NEEDS_REVISION" | "BLOCKED";
  score?: number | null;
  checks?: Array<{ check: string; status: "pass" | "warn" | "fail"; details: string }>;
  issues?: Array<{ severity: string; check: string; description: string; fix: string; classification?: string; origin?: string }>;
  flags?: string[];
  summary?: string;
  created: string;
}

export interface ContentUsage {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number | null;
  unpriced_calls: number;
  by_task: Record<string, { calls: number; input: number; output: number }>;
}

export const CONTENT_TYPE_LABELS: Record<ContentTypeKey, string> = {
  blog_article: "Blog article",
  service_page: "Service page",
  location_page: "Location page",
  guide: "Guide",
  comparison: "Comparison",
  faq_page: "FAQ page",
  existing_page_optimization: "Existing page optimization",
};

export const ARTICLE_STATUS_LABELS: Record<ArticleStatus, string> = {
  researching: "Researching",
  brief_ready: "Brief ready",
  outline_ready: "Outline ready",
  drafting: "Drafting",
  draft: "Draft",
  qa: "In QA",
  needs_revision: "Needs revision",
  awaiting_approval: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
  failed: "Failed",
};

export const JOB_STEP_LABELS: Record<string, string> = {
  queued: "Queued",
  building_context: "Building Context",
  researching: "Researching",
  building_brief: "Building Brief",
  creating_outline: "Creating Outline",
  writing_draft: "Writing Draft",
  optimizing_seo: "Optimizing SEO",
  checking_claims: "Checking Claims",
  fact_checking: "Fact Checking",
  quality_review: "Quality Review",
  revising: "Revising",
  awaiting_approval: "Awaiting Approval",
  awaiting_brief_review: "Awaiting Brief Review",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
