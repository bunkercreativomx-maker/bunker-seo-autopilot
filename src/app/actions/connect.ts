"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/pocketbase/auth";
import { OperationError, userOperation } from "@/lib/pocketbase/operations";

export type ConnectState = { error?: string; connected?: boolean; reason?: string; url?: string } | undefined;

export async function verifyConnectionAction(_p: ConnectState, f: FormData): Promise<ConnectState> {
  const websiteId = String(f.get("websiteId") ?? "");
  try {
    const { pb } = await requireUser();
    const r = await userOperation<{ connected: boolean; reason?: string; url?: string }>(pb, "connect/verify", { websiteId });
    revalidatePath(`/websites/${websiteId}/publishing`);
    revalidatePath(`/websites/${websiteId}`);
    revalidatePath("/today");
    return r;
  } catch (e) {
    return { error: e instanceof OperationError && e.status < 500 ? e.message : "Verification failed. Try again." };
  }
}

export async function disconnectAction(_p: ConnectState, f: FormData): Promise<ConnectState> {
  const websiteId = String(f.get("websiteId") ?? "");
  try {
    const { pb } = await requireUser();
    await userOperation(pb, "connect/disconnect", { websiteId });
    revalidatePath(`/websites/${websiteId}/publishing`);
    return { connected: false };
  } catch (e) {
    return { error: e instanceof OperationError && e.status < 500 ? e.message : "Could not disconnect." };
  }
}
