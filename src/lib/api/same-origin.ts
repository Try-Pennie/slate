import { NextResponse } from "next/server";
import { log } from "@/lib/log";

/**
 * Same origin defence in depth for the cookie authed admin mutation routes
 * (#1046).
 *
 * These routes carry no CSRF token. What stops a third party page making a
 * manager's browser POST a cancellation is that Supabase's SSR cookies default to
 * `SameSite=Lax`, so the session cookie is not attached to a cross site POST. That
 * default is correct and it is also a third party library's default: nothing in
 * this repo asserts it, and a Supabase change or a deliberate `sameSite` override
 * somewhere would remove the only thing holding the door.
 *
 * So the mutation routes also check where the request came from. The rule is the
 * conservative one: refuse when a request TELLS us it is not same origin, and stay
 * out of the way when it says nothing. A non browser caller (curl, a script) sends
 * neither header and is unaffected; every browser sends `Origin` on a POST and
 * every current browser sends `Sec-Fetch-Site` as well, so the case this covers is
 * exactly the browser driven one.
 *
 * Read routes are deliberately not covered. A cross site GET can be made, but the
 * attacker cannot read the response: the same origin policy blocks that and no
 * admin route sends CORS headers. The harm on this surface is the write.
 */

/** The three request headers the decision reads. */
export interface OriginHeaders {
  /** `Origin`, the origin of the page that initiated the request. */
  origin: string | null;
  /** `Sec-Fetch-Site`: `same-origin`, `same-site`, `cross-site` or `none`. */
  secFetchSite: string | null;
  /** `Host`, the origin the browser actually reached. */
  host: string | null;
}

/** Allowed, or refused with the reason (a log line, never client copy). */
export type SameOriginVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Whether a request may be treated as same origin.
 *
 * `Sec-Fetch-Site` is checked first because the browser sets it and it cannot be
 * spoofed by page script, so `same-origin` is the strongest signal available. Any
 * other value it carries is a refusal, `same-site` included: a sibling subdomain is
 * not this app, and `none` means the request did not come from a page at all, which
 * a POST from Slate's own UI never is.
 *
 * `Origin` is then compared by host and port against the `Host` the request
 * arrived on, rather than against a configured app URL. Production answers on one
 * hostname today (#1052 closed the workers.dev origin), but local development
 * answers on localhost and a configured value pinned to production would refuse
 * every legitimate request there while still reading as a working guard. Comparing
 * against the host the request actually arrived on is correct in both, and an
 * attacker cannot influence it: the browser sets `Host` to the site it reached and
 * `Origin` to the page that initiated the request.
 */
export function sameOriginVerdict(headers: OriginHeaders): SameOriginVerdict {
  const site = headers.secFetchSite?.trim();
  if (site && site !== "same-origin") {
    return { ok: false, reason: `Sec-Fetch-Site: ${site}` };
  }

  const origin = headers.origin?.trim();
  if (!origin) return { ok: true };

  const host = headers.host?.trim();
  if (!host) {
    // Nothing to compare against. A real browser request always carries Host, so
    // this is either a malformed request or a proxy that dropped it; either way the
    // comparison cannot be made and a guard that cannot measure must not pass.
    return { ok: false, reason: "Origin present with no Host to compare against" };
  }

  let originHost: string;
  try {
    // A sandboxed iframe and some redirect chains send the literal string "null",
    // which throws here and is refused, which is the right answer for both.
    originHost = new URL(origin).host;
  } catch {
    return { ok: false, reason: `unreadable Origin: ${origin}` };
  }
  if (originHost.toLowerCase() !== host.toLowerCase()) {
    return { ok: false, reason: `Origin ${originHost} does not match Host ${host}` };
  }
  return { ok: true };
}

/** What a refused caller is told. It names no header and no origin: the request
 *  either came from Slate's own UI, in which case a reload fixes a stale tab, or it
 *  did not, in which case there is nothing to explain to it. */
export const CROSS_ORIGIN_MESSAGE =
  "This request could not be verified. Please reload the page and try again.";

/** The header bag shape both `NextRequest` and a plain `Request` satisfy. */
interface HeaderReader {
  headers: { get(name: string): string | null };
}

/**
 * The one call a cookie authed mutation route makes: a `403` to return when the
 * request is not same origin, or `null` to carry on. Placed FIRST in the handler,
 * before the auth check and before the body is read, so a refused request costs
 * nothing and touches nothing.
 *
 * A refusal is logged rather than alerted. Under normal operation this fires zero
 * times, so the line is the record that something tried; paging on it would page on
 * any scanner that finds the URL.
 */
export function crossOriginRefusal(req: HeaderReader, route: string): NextResponse | null {
  const verdict = sameOriginVerdict({
    origin: req.headers.get("origin"),
    secFetchSite: req.headers.get("sec-fetch-site"),
    host: req.headers.get("host"),
  });
  if (verdict.ok) return null;
  log.warn("same-origin", { msg: "refused a cross-origin mutation", route, reason: verdict.reason });
  return NextResponse.json({ error: CROSS_ORIGIN_MESSAGE }, { status: 403 });
}
