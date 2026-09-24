export type PublisherType = "pocketbase_cms" | "nextjs_api" | "webhook" | "wordpress";
export type ConnectionStatus = "not_configured" | "connected" | "failed" | "unauthorized" | "invalid_response" | "timeout";

export const PUBLISHER_LABELS: Record<PublisherType, string> = {
  pocketbase_cms: "PocketBase CMS (site reads from PocketBase)",
  nextjs_api: "Next.js API (signed POST /api/bunker-content/publish)",
  webhook: "Signed webhook",
  wordpress: "WordPress REST API",
};

export const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  not_configured: "Not connected",
  connected: "Connected",
  failed: "Connection error",
  unauthorized: "Unauthorized",
  invalid_response: "Invalid response",
  timeout: "Timeout",
};

export interface PublishingWebsite {
  id: string;
  name: string;
  domain: string;
  client: string;
  publishing_enabled?: boolean;
  publisher_type?: PublisherType | "";
  publishing_mode?: string;
  publishing_environment?: "staging" | "production" | "";
  base_url?: string;
  blog_path?: string;
  api_endpoint?: string;
  allowed_domains?: string[] | null;
  connection_status?: ConnectionStatus | "";
  last_connection_test?: string;
  last_connection_error?: string;
  auto_revalidate?: boolean;
  publishing_configuration?: Record<string, unknown> | null;
  last_publication_at?: string;
}

/** Integration as visible to users (hidden secret fields are never returned by PocketBase). */
export interface IntegrationView {
  id: string;
  website: string;
  publisher_type: PublisherType;
  status: "active" | "disabled";
  secret_last4?: string;
  secret_set_at?: string;
  previous_secret_valid_until?: string;
  username?: string;
  config?: Record<string, unknown> | null;
}

export interface PublishJob {
  id: string;
  organization: string;
  client: string;
  website: string;
  article?: string;
  publication?: string;
  operation: string;
  publisher_type?: string;
  status: string;
  attempt?: number;
  max_attempts?: number;
  article_version?: number;
  requested_by?: string;
  requested_at?: string;
  started_at?: string;
  completed_at?: string;
  public_url?: string;
  remote_id?: string;
  error_code?: string;
  error_message?: string;
  created: string;
  expand?: { website?: { name?: string }; article?: { title?: string } };
}

export interface ArticlePublication {
  id: string;
  article: string;
  website: string;
  article_version: number;
  version_hash?: string;
  publisher_type: string;
  remote_id?: string;
  public_url?: string;
  slug?: string;
  status: "publishing" | "verification_required" | "published" | "unpublished" | "failed";
  published_at?: string;
  last_verified_at?: string;
  unpublished_at?: string;
  expand?: { website?: { name?: string }; published_by?: { name?: string; email?: string } };
}

export interface PublicationEvent {
  id: string;
  operation: string;
  status: string;
  version?: number;
  public_url?: string;
  created_at?: string;
  created: string;
  details?: { reason?: string; error_code?: string; hash?: string } | null;
  expand?: { actor?: { name?: string; email?: string } };
}

export interface PublishPreview {
  operation: "publish" | "update" | "republish";
  website: { id: string; name: string; domain: string; environment: string; publisher: string };
  version: number;
  current_version: number;
  title: string;
  slug: string;
  content_type: string;
  url_preview: string;
  high_risk: boolean;
  blockers: string[];
  slug_conflict: boolean;
  publication: { id: string; status: string; version: number; public_url: string } | null;
}

export function connectionTone(s?: string): "slate" | "green" | "amber" | "red" | "blue" {
  if (s === "connected") return "green";
  if (!s || s === "not_configured") return "slate";
  return "red";
}

export function publicationTone(s?: string): "slate" | "green" | "amber" | "red" | "blue" {
  if (s === "published") return "green";
  if (s === "verification_required") return "amber";
  if (s === "failed") return "red";
  if (s === "publishing") return "blue";
  return "slate";
}
