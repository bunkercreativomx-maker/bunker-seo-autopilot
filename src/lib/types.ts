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
  | "WEBSITE_ARCHIVED";

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

export const PLATFORMS: WebsitePlatform[] = ["nextjs", "react", "wordpress", "custom", "other"];
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
