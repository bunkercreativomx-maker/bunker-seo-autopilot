import { z } from "zod";
import { isValidDomain, isValidUrl, slugify } from "@/lib/types";

export const clientSchema = z.object({
  business_name: z.string().trim().min(1, "Business name is required").max(200),
  industry: z.string().trim().max(200).optional().or(z.literal("")),
  description: z.string().trim().max(5000).optional().or(z.literal("")),
  primary_language: z.string().trim().max(50).optional().or(z.literal("")),
  secondary_languages: z.string().trim().max(200).optional().or(z.literal("")),
  country: z.string().trim().max(100).optional().or(z.literal("")),
  primary_location: z.string().trim().max(200).optional().or(z.literal("")),
  service_areas: z.string().trim().max(500).optional().or(z.literal("")),
  target_audience: z.string().trim().max(500).optional().or(z.literal("")),
  brand_voice: z.string().trim().max(500).optional().or(z.literal("")),
  services: z.string().trim().max(1000).optional().or(z.literal("")),
  products: z.string().trim().max(1000).optional().or(z.literal("")),
  unique_selling_proposition: z.string().trim().max(500).optional().or(z.literal("")),
  primary_cta: z.string().trim().max(200).optional().or(z.literal("")),
  phone: z.string().trim().max(50).optional().or(z.literal("")),
  email: z.string().trim().email("Invalid email").optional().or(z.literal("")),
  status: z.enum(["active", "inactive", "archived"]),
});

export const websiteSchema = z.object({
  client: z.string().min(1, "Client is required"),
  name: z.string().trim().min(1, "Website name is required").max(200),
  domain: z
    .string()
    .trim()
    .min(1, "Domain is required")
    .refine(isValidDomain, "Invalid domain (e.g. example.com)"),
  platform: z.enum(["nextjs", "react", "wordpress", "custom", "other"]),
  primary_language: z.string().trim().max(50).optional().or(z.literal("")),
  country: z.string().trim().max(100).optional().or(z.literal("")),
  target_locations: z.string().trim().max(500).optional().or(z.literal("")),
  sitemap_url: z
    .string()
    .trim()
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || isValidUrl(v), "Invalid URL"),
  robots_url: z
    .string()
    .trim()
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || isValidUrl(v), "Invalid URL"),
  blog_url: z
    .string()
    .trim()
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || isValidUrl(v), "Invalid URL"),
  status: z.enum(["active", "inactive", "archived"]),
});

export type ClientFormData = z.infer<typeof clientSchema>;
export type WebsiteFormData = z.infer<typeof websiteSchema>;

export function clientSlug(businessName: string): string {
  return slugify(businessName);
}
