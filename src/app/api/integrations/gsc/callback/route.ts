import { NextRequest, NextResponse } from "next/server";
import { getSessionClient } from "@/lib/pocketbase/auth";
import { OperationError, userOperation } from "@/lib/pocketbase/operations";

/**
 * Google OAuth redirect URI (must match the Google Cloud client EXACTLY).
 * Runs as the signed-in user: PocketBase verifies the single-use state is
 * bound to this user + organization + website and unexpired, consumes it,
 * exchanges the code server-side and stores the refresh token encrypted.
 * No token ever reaches this response or the browser.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const origin = req.nextUrl.origin;
  const params = req.nextUrl.searchParams;
  const pb = await getSessionClient();
  if (!pb) return NextResponse.redirect(new URL("/login?next=/websites", origin));
  const state = params.get("state") ?? "";
  const code = params.get("code") ?? "";
  const error = params.get("error") ?? "";
  try {
    const r = await userOperation<{ websiteId: string; connectionId: string; googleAccountEmail: string; reconnected: boolean }>(pb, "gsc/oauth/complete", { state, code, error: error || undefined });
    const to = new URL(`/websites/${r.websiteId}/search-console`, origin);
    to.searchParams.set("connected", r.reconnected ? "reconnected" : "1");
    to.searchParams.set("connection", r.connectionId);
    return NextResponse.redirect(to);
  } catch (e) {
    const code = e instanceof OperationError ? e.code : "OAUTH_FAILED";
    const msg = e instanceof OperationError && e.status < 500 ? e.message : "The Google connection could not be completed.";
    const to = new URL("/websites", origin);
    to.searchParams.set("gsc_error", code);
    to.searchParams.set("gsc_message", msg.slice(0, 300));
    return NextResponse.redirect(to);
  }
}
