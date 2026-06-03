import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { publicSupabasePublishableKey, publicSupabaseUrl } from "@/lib/env";

/**
 * Refreshes the Supabase auth session cookie on each request so Server
 * Components always see a valid session. Booking, embed, API, and Google
 * webhook routes are public and skipped via the matcher below.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    publicSupabaseUrl(),
    publicSupabasePublishableKey(),
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          for (const { name, value } of toSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of toSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  await supabase.auth.getUser();
  return response;
}

export const config = {
  // Only run on admin/app pages — keep public booking + API + webhooks fast.
  // Classic middleware.ts runs on the Edge runtime (what OpenNext/Cloudflare needs);
  // Next 16's proxy.ts is Node-only, so we keep this convention despite the warning.
  matcher: ["/admin/:path*", "/me", "/login"],
};
