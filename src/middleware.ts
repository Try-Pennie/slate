import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { publicSupabasePublishableKey, publicSupabaseUrl } from "@/lib/env";
import { SECURITY_HEADERS } from "@/lib/security-headers";
import { supabaseFetch } from "@/lib/supabase/fetch";
import {
  buildContentSecurityPolicy,
  cspNonce,
  reportingEndpointsHeader,
  themeScriptHashes,
} from "@/lib/csp";

/**
 * Refreshes the Supabase auth session cookie on staff requests so Server
 * Components always see a valid session, and stamps the security headers.
 *
 * Since #2565 the matcher also covers the PUBLIC surfaces, because the script
 * policy needs a per request nonce and only the middleware can mint one. Those
 * requests deliberately skip the session refresh: the booker is the hot path and
 * an auth round trip on every embed load, to set a header, would be a real cost
 * on the surface this policy is most about.
 */

/** The staff surfaces: a session to refresh, and framing to forbid. */
function isStaffPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/admin" ||
    pathname === "/me" ||
    pathname.startsWith("/admin/") ||
    pathname.startsWith("/me/")
  );
}

export async function middleware(request: NextRequest) {
  const staff = isStaffPath(request.nextUrl.pathname);
  const nonce = cspNonce();
  // ENFORCED on every path this runs on, lead pages and staff alike (#2575).
  //
  // The staff paths were left out of the report only phase for a measured reason
  // (2026-09-18): Next reads the nonce from
  // `headers['content-security-policy'] || headers['content-security-policy-report-only']`,
  // the staff paths already served an enforcing `frame-ancestors 'none'` (#592),
  // so that header won the read, carried no nonce, and /login got 0 of 26 script
  // tags nonced. Enforcing makes the two headers ONE: the framing rule rides in
  // the same policy as `script-src`, so the header Next reads is the one carrying
  // the nonce.
  //
  // `frameable` is what keeps the booker alive: the whole product is an embed on
  // partner pages, so a frame-ancestors on /book would black the booker out on
  // somebody else's site, where the only error appears in a console we never see.
  //
  // Slate's own theme boot scripts are allowed by HASH, because Next nonces its
  // own inline scripts and not ours, and giving these a nonce would mean reading
  // the request inside the root layout, forcing every page it serves to render
  // dynamically for a script whose text never varies. Computed once per isolate.
  const scriptHashes = await themeScriptHashes();
  const policy = buildContentSecurityPolicy({
    nonce,
    frameable: !staff,
    scriptHashes,
    // The sign in page builds a Supabase browser client, which talks to the
    // project's own origin. Only the staff pages have one.
    connectSources: staff ? [new URL(publicSupabaseUrl()).origin] : [],
  });

  // Set on the REQUEST as well as the response. Next reads the request's policy
  // while rendering (`app-render.js`) and applies its nonce to its own inline
  // scripts; without this every one of them would be refused and the page would
  // not run.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", policy);
  requestHeaders.set("x-nonce", nonce);

  let response = NextResponse.next({ request: { headers: requestHeaders } });

  if (staff) {
    const supabase = createServerClient(
      publicSupabaseUrl(),
      publicSupabasePublishableKey(),
      {
        // #3102: a hung auth server must not hold every staff page open.
        global: { fetch: supabaseFetch },
        cookies: {
          getAll: () => request.cookies.getAll(),
          setAll: (toSet) => {
            for (const { name, value } of toSet) {
              request.cookies.set(name, value);
            }
            response = NextResponse.next({ request: { headers: requestHeaders } });
            for (const { name, value, options } of toSet) {
              response.cookies.set(name, value, options);
            }
          },
        },
      },
    );

    await supabase.auth.getUser();

    // Clickjacking hardening on the staff surfaces (#592). Set after the refresh
    // so it lands on the final response, even after a cookie refresh reassigned
    // it above. The booker never gets these, so the embed stays frameable.
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      response.headers.set(name, value);
    }
  }

  // Last, for the same reason: whatever response the refresh left is the one
  // that carries the policy.
  response.headers.set("content-security-policy", policy);
  response.headers.set("reporting-endpoints", reportingEndpointsHeader());
  return response;
}

export const config = {
  // Classic middleware.ts runs on the Edge runtime (what OpenNext/Cloudflare needs);
  // Next 16's proxy.ts is Node-only, so we keep this convention despite the warning.
  // `/me/:path*` and not `/me`: the time off page moved to a CHILD route on
  // 2026-09-08, and an exact "/me" would have left it with no session refresh
  // and none of the SECURITY_HEADERS above (#592), which is a clickjacking
  // regression nothing would have reported. Next matches the parent too.
  //
  // `/book` and `/booking/:path*` joined for the CSP nonce (#2565). They take the
  // `staff === false` path above: a policy and nothing else, no session refresh
  // and no framing headers. /api is deliberately absent, because an API response
  // renders no scripts and a policy on it would protect nothing.
  matcher: ["/admin/:path*", "/me/:path*", "/login", "/book", "/book/:path*", "/booking/:path*"],
};
