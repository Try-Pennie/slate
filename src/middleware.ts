import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { readFrameLock, recordFramingObservation } from "@/lib/embed/frame-guard";
import { frameAncestorSources, framingObservation } from "@/lib/embed/frame-policy";
import { createServerClient } from "@supabase/ssr";
import { publicSupabasePublishableKey, publicSupabaseUrl } from "@/lib/env";
import { SECURITY_HEADERS } from "@/lib/security-headers";
import { supabaseEdgeFetch } from "@/lib/supabase/fetch-deadline";
import { hardenAuthCookie, serverAuthCookieOptions } from "@/lib/supabase/cookie-options";
import {
  SESSION_SEEN_COOKIE,
  SESSION_STARTED_COOKIE,
  hasSupabaseSessionCookie,
  judgeSessionAge,
  sessionCookiesToClear,
  sessionRefusalLoginError,
  sessionStampCookieOptions,
  stampValue,
  type SessionAgeRefusal,
} from "@/lib/auth/session-age";
import { log } from "@/lib/log";
import { isSignInPath } from "@/lib/auth/sign-in-page";
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
    // Both sign in pages (#4379): /login, and the partner page where invited coordinators
    // sign in with Microsoft. Each builds the Supabase browser client.
    isSignInPath(pathname) ||
    pathname === "/admin" ||
    pathname === "/me" ||
    pathname.startsWith("/admin/") ||
    pathname.startsWith("/me/") ||
    // #4205: the coordinator booking page, a staff surface like the console.
    pathname === "/coordinator" ||
    pathname.startsWith("/coordinator/")
  );
}

/**
 * The lead surfaces, which partner pages embed, so the only paths other SITES may frame.
 *
 * Since #3136 the matcher reaches every page, and a path is frameable only by being named
 * here: a page added anywhere else is refused framing by default rather than shipping with
 * no policy at all. The one other exception is `/demo`, which Slate's OWN pages may frame
 * and nobody else (`sameOriginFrameable` in `middleware`, #3718, Dan 2026-10-15).
 */
function isFrameablePath(pathname: string): boolean {
  return (
    pathname === "/book" ||
    pathname === "/booking" ||
    pathname.startsWith("/book/") ||
    pathname.startsWith("/booking/")
  );
}

export async function middleware(request: NextRequest, event?: NextFetchEvent) {
  const staff = isStaffPath(request.nextUrl.pathname);
  const frameable = isFrameablePath(request.nextUrl.pathname);
  // #3718 (Dan, 2026-10-15): the demo booker may be framed by Slate's own pages and
  // nothing else, so the demo pieces page can draw it through the real widget.js.
  // Every other non booker page keeps the refusal.
  const sameOriginFrameable = request.nextUrl.pathname === "/demo";
  const nonce = cspNonce();
  // #3137: the frame lock, a stored admin switch that defaults off. Read only for the
  // frameable pages, through a short per isolate cache, so the booker pays one small
  // read per isolate every few seconds rather than one per load.
  const frameLocked = frameable ? await readFrameLock() : false;
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
    frameable: frameable || sameOriginFrameable,
    // #3137: locked, every frameable page (the booker and each page it moves to inside
    // its frame) may be framed only by Slate and the allow list. Unlocked, as before.
    frameAncestors: sameOriginFrameable ? ["'self'"] : frameLocked ? frameAncestorSources() : undefined,
    scriptHashes,
    // The sign in pages build a Supabase browser client, which talks to the
    // project's own origin. Only the staff paths have one.
    connectSources: staff ? [new URL(publicSupabaseUrl()).origin] : [],
  });

  // Set on the REQUEST as well as the response. Next reads the request's policy
  // while rendering (`app-render.js`) and applies its nonce to its own inline
  // scripts; without this every one of them would be refused and the page would
  // not run.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", policy);
  requestHeaders.set("x-nonce", nonce);

  // #3084: a staff sign in ends 30 days after it started, or after 7 days without a
  // staff request. Judged before the refresh, so an expired session is not refreshed
  // one last time. Only for a request that carries a session at all, so somebody who
  // never signed in meets the ordinary sign in rather than "you were signed out"; and
  // never on a sign in page itself, which is where a refused session is sent.
  const sessionPresent =
    staff &&
    !isSignInPath(request.nextUrl.pathname) &&
    hasSupabaseSessionCookie(request.cookies.getAll().map((c) => c.name));
  const nowMs = Date.now();
  if (sessionPresent) {
    const verdict = judgeSessionAge({
      started: request.cookies.get(SESSION_STARTED_COOKIE)?.value,
      seen: request.cookies.get(SESSION_SEEN_COOKIE)?.value,
      nowMs,
    });
    if (!verdict.admit) return endAgedSession(request, verdict.reason, policy);
  }

  let response = NextResponse.next({ request: { headers: requestHeaders } });
  let sessionLive = false;

  if (staff) {
    const supabase = createServerClient(
      publicSupabaseUrl(),
      publicSupabasePublishableKey(),
      {
        // #3102: a hung auth server must not hold every staff page open.
        global: { fetch: supabaseEdgeFetch },
        // #3112: httpOnly, Secure in production, clamped to the idle limit.
        cookieOptions: serverAuthCookieOptions(),
        cookies: {
          getAll: () => request.cookies.getAll(),
          setAll: (toSet) => {
            for (const { name, value } of toSet) {
              request.cookies.set(name, value);
            }
            response = NextResponse.next({ request: { headers: requestHeaders } });
            for (const { name, value, options } of toSet) {
              response.cookies.set(name, value, hardenAuthCookie(options));
            }
          },
        },
      },
    );

    const { data } = await supabase.auth.getUser();
    sessionLive = data.user != null;
  }

  // #3084: an admitted staff request is a use, so the idle clock restarts. Set after
  // the refresh, which can reassign the response. Only for a session Supabase still
  // recognises: restamping a dead one would keep a stale cookie looking freshly used.
  if (sessionPresent && sessionLive) {
    response.cookies.set(SESSION_SEEN_COOKIE, stampValue(nowMs), sessionStampCookieOptions("seen"));
  }

  // Clickjacking hardening on every surface that is not the booker (#592, #3136). Set
  // after the refresh so it lands on the final response, even after a cookie refresh
  // reassigned it above. The booker never gets these, so the embed stays frameable.
  if (!frameable) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      response.headers.set(name, value);
    }
    // Reviewed (Dan, 2026-10-15): the value is a fixed literal, not request input; the
    // request only decides WHETHER it applies, and only for exactly /demo, which Slate's
    // own pages may frame. Pinned by src/middleware.test.ts.
    // nosemgrep: javascript.express.security.x-frame-options-misconfiguration.x-frame-options-misconfiguration
    if (sameOriginFrameable) response.headers.set("X-Frame-Options", "SAMEORIGIN");
  }

  // #3137 OBSERVE: count who frames the booker, as an origin and a page name, after the
  // response has gone. Recorded whether or not the lock is on, so with it on the count
  // still shows a partner the browser is now refusing.
  if (frameable) {
    const seen = framingObservation({
      method: request.method,
      dest: request.headers.get("sec-fetch-dest"),
      referer: request.headers.get("referer"),
      declared: request.nextUrl.searchParams.get("parentOrigin"),
      ownOrigin: request.nextUrl.origin,
      pathname: request.nextUrl.pathname,
    });
    // Batched per isolate, so a flood of invented origins costs a bounded number of
    // writes (frame-observe.ts). A write it does make outlives the response through
    // this request's waitUntil; with none (a unit test) it simply floats, already caught.
    if (seen) recordFramingObservation(seen, (work) => event?.waitUntil(work));
  }

  // Last, for the same reason: whatever response the refresh left is the one
  // that carries the policy.
  response.headers.set("content-security-policy", policy);
  response.headers.set("reporting-endpoints", reportingEndpointsHeader());
  return response;
}

/**
 * Send a session past its age limit to sign in again (#3084), with a sentence saying
 * why. Its refresh token is revoked as well as its cookies cleared, so a copy of the
 * cookie taken off the device dies with it. A revoke that fails is logged and the
 * cookies are cleared regardless: the person on this device is signed out either way,
 * and the hosted session limits are what end the refresh token then.
 */
async function endAgedSession(
  request: NextRequest,
  reason: SessionAgeRefusal,
  policy: string,
): Promise<NextResponse> {
  const to = new URL("/login", request.url);
  to.searchParams.set("error", sessionRefusalLoginError(reason));
  // 303 rather than the default 307: a server action is a POST, and a 307 would have
  // the browser repeat it against /login. 303 makes any method a GET of the page.
  const res = NextResponse.redirect(to, 303);
  log.warn("auth", { msg: "session past its age limit, signing out", reason });

  try {
    const supabase = createServerClient(publicSupabaseUrl(), publicSupabasePublishableKey(), {
      cookieOptions: serverAuthCookieOptions(),
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          for (const { name, value, options } of toSet) {
            res.cookies.set(name, value, hardenAuthCookie(options));
          }
        },
      },
    });
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) log.warn("auth", { msg: "revoking an aged session failed", reason }, error);
  } catch (err) {
    log.warn("auth", { msg: "revoking an aged session failed", reason }, err);
  }

  for (const name of sessionCookiesToClear(request.cookies.getAll().map((c) => c.name))) {
    res.cookies.set(name, "", { ...serverAuthCookieOptions(), maxAge: 0 });
  }
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.headers.set(name, value);
  }
  res.headers.set("content-security-policy", policy);
  res.headers.set("reporting-endpoints", reportingEndpointsHeader());
  return res;
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
  // and no framing headers.
  //
  // #3136 inverted it: EVERY path except /api, Next's own assets and static files,
  // because a list of prefixes left /, /advisor-photo and /dev/preview with no policy
  // and would have done the same to the next page added. /api is still excluded,
  // because an API response renders no scripts and a policy on it would protect
  // nothing. src/middleware-matcher.test.ts asks Next whether each served path matches.
  matcher: [
    "/((?!api(?:/|$)|_next/|.*\\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|txt|xml|json|webmanifest|woff2?|ttf|html)$).*)",
  ],
};
