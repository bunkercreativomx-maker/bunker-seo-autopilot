import "server-only";
import type PocketBase from "pocketbase";
import type { Website, WebsiteExpanded, WebsitePlatform } from "@/lib/types";

export interface WebsiteInput {
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
  status: Website["status"];
}

export async function listWebsites(pb: PocketBase): Promise<WebsiteExpanded[]> {
  const res = await pb.collection("websites").getList<WebsiteExpanded>(1, 200, {
    sort: "-created_at",
    expand: "client,organization",
  });
  return res.items;
}

export async function listWebsitesByClient(pb: PocketBase, clientId: string): Promise<WebsiteExpanded[]> {
  const res = await pb.collection("websites").getList<WebsiteExpanded>(1, 200, {
    filter: `client = "${clientId}"`,
    sort: "-created_at",
    expand: "client,organization",
  });
  return res.items;
}

export async function getWebsite(pb: PocketBase, id: string): Promise<WebsiteExpanded | null> {
  try {
    return await pb.collection("websites").getOne<WebsiteExpanded>(id, { expand: "client,organization" });
  } catch {
    return null;
  }
}

export async function createWebsite(pb: PocketBase, organization: string, input: WebsiteInput): Promise<Website> {
  return await pb.collection("websites").create<Website>({
    organization,
    ...input,
    created_at: new Date().toISOString(),
  });
}

export async function updateWebsite(pb: PocketBase, id: string, input: Partial<WebsiteInput>): Promise<Website> {
  return await pb.collection("websites").update<Website>(id, input);
}

export async function archiveWebsite(pb: PocketBase, id: string): Promise<Website> {
  return await pb.collection("websites").update<Website>(id, { status: "archived" });
}
