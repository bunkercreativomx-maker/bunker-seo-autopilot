import "server-only";
import type PocketBase from "pocketbase";

/**
 * Calls a trusted PocketBase endpoint (pb_hooks/bsa_routes.pb.js) AS THE
 * SIGNED-IN USER. The user's own token is forwarded; PocketBase derives the
 * organization/role from the database and enforces tenant + permission checks.
 * The Next.js app never holds superuser credentials.
 */
export class OperationError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "OperationError";
    this.status = status;
    this.code = code;
  }
}

export async function userOperation<T = Record<string, unknown>>(pb: PocketBase, path: string, body: Record<string, unknown>): Promise<T> {
  if (!pb.authStore.isValid || !pb.authStore.token) throw new OperationError(401, "UNAUTHENTICATED", "Sign in to continue.");
  try {
    return await pb.send<T>(`/api/bsa/${path}`, { method: "POST", body, requestKey: null });
  } catch (error) {
    const e = error as { status?: number; response?: { code?: string; message?: string } };
    const status = Number(e?.status) || 500;
    const code = String(e?.response?.code || (status === 401 ? "UNAUTHENTICATED" : status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : "INTERNAL"));
    const message = status >= 500 || !e?.response?.message ? "The operation failed. Please try again." : String(e.response.message);
    throw new OperationError(status, code, message);
  }
}
