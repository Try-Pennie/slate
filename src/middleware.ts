import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { publicSupabasePublishableKey, publicSupabaseUrl } from "@/lib/env";
import { SECURITY_HEADERS } from "@/lib/security-headers";
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
  // Report only covers the PUBLIC surfaces and deliberately not the staff ones,
  // and the reason is measured rather than assumed (2026-09-18, dev server).
  //
  // Next reads the nonce from
  // `headers['content-security-policy'] || headers['content-security-policy-report-only']`.
  // The staff paths already serve an ENFORCING `Content-Security-Policy:
  // frame-ancestors 'none'` (#592), so that first read wins, finds no nonce in it,
  // and Next applies none: /login, /admin and /me got 0 of 26 script tags nonced
  // while /book got 25 of 26. Every one of those would then be reported on every
  // load, and one page producing more violation reports than the rest of the
  // product would bury any real finding.
  //
  // The three ways out were all worse. Folding `script-src` into the enforcing
  // header ENFORCES it on the staff pages in a phase whose whole point is not to;
  // dropping the enforcing `frame-ancestors` to let the report only header through
  // weakens a clickjacking control for a diagnostic; and threading the nonce
  // through each page by hand is the change this middleware exists to avoid.
  //
  // So the staff paths keep exactly what they have and join when the policy is
  // enforced. The public surfaces are where the risk lives anyway: the booker is
  // the one that renders attendee supplied data.
  //
  // `frameable` stays as the parameter because it is the right shape for that
  // later change: the whole product is an embed on partner pages, so a
  // frame-ancestors on /book would black the booker out on somebody else's site,
  // where the only error appears in a console we never see.
  // Slate's own theme boot scripts are allowed by HASH, because Next nonces its
  // own inline scripts and not ours, and giving these a nonce would mean reading
  // the request inside the root layout, forcing every page it serves to render
  // dynamically for a script whose text never varies. Computed once per isolate.
  const scriptHashes = await themeScriptHashes();
  const policy = buildContentSecurityPolicy({ nonce, frameable: !staff, scriptHashes });

  // Set on the REQUEST as well as the response, which is what makes the report
  // only phase worth running. Next reads
  // `headers['content-security-policy'] || headers['content-security-policy-report-only']`
  // while rendering (`app-render.js`) and applies the nonce to its own inline
  // scripts. Without this the policy would report every inline script on every
  // page and the noise would bury any real finding.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy-report-only", policy);
  requestHeaders.set("x-nonce", nonce);

  let response = NextResponse.next({ request: { headers: requestHeaders } });

  if (staff) {
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
            response = NextResponse.next({ request: { headers: requestHeaders } });
            for (const { name, value, options } of toSet) {
              response.cookies.set(name, value, options);
            }
          },
        },
      },
    );

    await supabase.auth.getUser();

    // Clickjacking + baseline hardening on the staff surfaces (#592). Set last so
    // they land on the final response, even after a cookie refresh reassigned it
    // above. The booker never gets these, so the embed stays frameable.
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      response.headers.set(name, value);
    }
  }

  // REPORT ONLY, deliberately. The enforcing header stays exactly what it was:
  // `frame-ancestors 'none'` on staff paths and nothing anywhere else. Enforcing
  // this policy is a separate change, gated on reading real violations rather
  // than on it looking right.
  if (!staff) {
    response.headers.set("content-security-policy-report-only", policy);
    response.headers.set("reporting-endpoints", reportingEndpointsHeader());
  }
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
  // `staff === false` path above: a policy header and nothing else, no session
  // refresh and no framing headers. /api is deliberately absent, because an API
  // response renders no scripts and a policy on it would report nothing. The staff
  // entries stay for the session refresh they have always done; they get no policy
  // header in this phase, for the measured reason above.
  matcher: ["/admin/:path*", "/me/:path*", "/login", "/book", "/book/:path*", "/booking/:path*"],
};
