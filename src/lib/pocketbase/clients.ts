import "server-only";
import type PocketBase from "pocketbase";
import type { Client, ClientExpanded } from "@/lib/types";

export interface ClientInput {
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
  status: Client["status"];
}

export async function listClients(pb: PocketBase): Promise<ClientExpanded[]> {
  const res = await pb.collection("clients").getList<ClientExpanded>(1, 200, {
    sort: "-created_at",
    expand: "organization",
  });
  return res.items;
}

export async function getClient(pb: PocketBase, id: string): Promise<ClientExpanded | null> {
  try {
    return await pb.collection("clients").getOne<ClientExpanded>(id, { expand: "organization" });
  } catch {
    return null;
  }
}

export async function createClient(pb: PocketBase, organization: string, input: ClientInput): Promise<Client> {
  return await pb.collection("clients").create<Client>({
    organization,
    ...input,
    created_at: new Date().toISOString(),
  });
}

export async function updateClient(pb: PocketBase, id: string, input: Partial<ClientInput>): Promise<Client> {
  return await pb.collection("clients").update<Client>(id, input);
}

export async function archiveClient(pb: PocketBase, id: string): Promise<Client> {
  return await pb.collection("clients").update<Client>(id, { status: "archived" });
}
