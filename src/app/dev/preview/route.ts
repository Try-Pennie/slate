import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { DEV_PREVIEW_COOKIE, devPreviewEnabled, isLoopbackHost } from "@/lib/auth/dev-preview";

export const dynamic = "force-dynamic";

/**
 * DEV-ONLY: view the app as any user without OAuth.
 *   /dev/preview?email=agent@trypennie.com  -> become that user, go to /me
 *   /dev/preview?email=clear                -> drop the preview, go to /login
 * Returns 404 unless the gate is on (development, SLATE_DEV_PREVIEW=1) AND the
 * request came to a loopback host (#3086).
 */
export async function GET(req: NextRequest) {
  if (!devPreviewEnabled() || !isLoopbackHost(req.headers.get("host"))) {
    return new NextResponse("Not found", { status: 404 });
  }
  const email = (req.nextUrl.searchParams.get("email") ?? "").trim().toLowerCase();
  const store = await cookies();
  if (!email || email === "clear") {
    store.delete(DEV_PREVIEW_COOKIE);
    return NextResponse.redirect(new URL("/login", req.url));
  }
  store.set(DEV_PREVIEW_COOKIE, email, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  return NextResponse.redirect(new URL("/me", req.url));
}
