import { NextRequest, NextResponse } from "next/server";

const AUTH_COOKIE = "pb_auth";

// Protected app routes (everything under the app shell).
const protectedPrefixes = ["/dashboard", "/clients", "/websites", "/activity", "/settings"];
const publicRoutes = ["/login"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(AUTH_COOKIE)?.value);

  const isProtected = protectedPrefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const isPublic = publicRoutes.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  // Unauthenticated user hitting a protected route -> login.
  if (isProtected && !hasSession) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Authenticated user hitting login -> dashboard.
  if (isPublic && hasSession) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Run on all routes except static assets and API.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|ico|jpg|jpeg|webp|gif)$).*)"],
};
