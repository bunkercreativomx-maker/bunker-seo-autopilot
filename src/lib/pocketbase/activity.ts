import "server-only";
import { createBaseClient, adminAuth } from "./client";
import type { ActivityAction } from "@/lib/types";

/**
 * Write an activity log entry using the admin (superuser) client.
 * activity_logs.createRule is null, so only the admin client can write.
 * Never throws — logging must never break the primary mutation.
 */
export async function logActivity(input: {
  organization: string;
  user?: string;
  client?: string;
  website?: string;
  action: ActivityAction;
  entity_type?: string;
  entity_id?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    const pb = createBaseClient();
    await adminAuth(pb);
    await pb.collection("activity_logs").create({
      organization: input.organization,
      user: input.user ?? "",
      client: input.client ?? "",
      website: input.website ?? "",
      action: input.action,
      entity_type: input.entity_type ?? "",
      entity_id: input.entity_id ?? "",
      metadata: input.metadata ?? {},
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("[activity] failed to log", input.action, e);
  }
}
