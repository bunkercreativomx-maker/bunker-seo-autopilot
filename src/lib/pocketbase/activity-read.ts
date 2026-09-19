import "server-only";
import type PocketBase from "pocketbase";
import type { ActivityLogExpanded } from "@/lib/types";

export async function listActivity(pb: PocketBase, limit = 50): Promise<ActivityLogExpanded[]> {
  const res = await pb.collection("activity_logs").getList<ActivityLogExpanded>(1, limit, {
    sort: "-created_at",
    expand: "user,client,website",
  });
  return res.items;
}
