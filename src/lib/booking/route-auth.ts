import { stampSeenIp, stampRefusedBy } from "@/lib/loadtest-echo";
import { NextResponse, type NextRequest } from "next/server";
import { configuredBookingApiKeys } from "@/lib/booking/api-keys";
import {
  FULL_API_CALLERS,
  type ApiKey,
  type AuthRefusalReason,
  type BookingApiCaller,
  type FullApiCaller,
  authRefusalCounting,
  authenticateBearer,
  refusalReasonForStatus,
} from "@/lib/booking/api-auth";
import { recordApiOutcome } from "@/lib/monitor/record-api-outcome";
import { recordCallerSeen } from "@/lib/booking/record-caller-seen";
import { watchRetiredKey } from "@/lib/booking/retired-key-watch";
import { bearerToken } from "@/lib/bearer-auth";
import type { SelfInflictedRefusal } from "@/lib/monitor/booking-api-outcome";
import { log } from "@/lib/log";
import {
  exactCeilingWithinLimit,
  clientIp,
  bookingApiWriteWithinLimit,
  bookingApiReadWithinLimit,
  bookingApiIpWithinLimit,
  bearerFailureWithinLimit,
} from "@/lib/rate-limit";
import { BOOKING_API_IP_LIMITER } from "@/lib/rate-limit-core";
import {
  DIRECT_BOOKING_API_HOURLY_RATE_RULES,
  DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
} from "@/lib/rate-limit-core";
import type { RateLimitRule } from "@/lib/rate-limit-core";

export type AuthOutcome<C extends BookingApiCaller = FullApiCaller> =
  /** #2645: `caller` is who the key belongs to, `keyId` which of its slots. */
  | { ok: true; keyId: ApiKey["id"]; caller: C }
  /**
   * #1429: the refusal now says WHICH one it was. A rotated key (the integration
   * cannot book at all) and a rate ceiling trip (one caller going too fast) sat
   * behind one branch, so nothing downstream could tell a config outage from
   * abuse shaping.
   */
  | { ok: false; reason: AuthRefusalReason; response: NextResponse };

/**
 * Build the refusal, record it if the catalog says it is counted, and always log
 * which one it was.
 *
 * The counting decision lives in `authRefusalCounting`, not here, so the rule that
 * a rotated key is a failure and a throttle is not is written down once with its
 * reasoning (src/lib/booking/refusal-catalog.ts) rather than being re-derived per
 * call site. The log line carries the reason either way, which is the only signal
 * an uncounted refusal has.
 */
function refuse(
  reason: AuthRefusalReason,
  error: string,
  status: 401 | 429 | 503,
  readPath: boolean,
  /** The request's headers, so the refusal can echo the address it was keyed on. */
  headers: Headers,
  keyId?: ApiKey["id"],
  /** Whether a Bearer token was actually SENT (#1450). Only meaningful for a
   *  credential refusal, and only on the write path. */
  tokenPresent = false,
): Extract<AuthOutcome, { ok: false }> {
  const counting = authRefusalCounting(reason, readPath ? "read" : "write");
  // #1442: a ceiling trip stays OUT of the failure share, and that decision is
  // unchanged. What it left invisible is a SUSTAINED trip on the write path,
  // which does not mean the caller is abusive, it means the ceiling is wrong for
  // the bot's real volume and leads are being turned away by us. So it is counted
  // under its own name, outside OUTCOME_ORDER, where it can be measured against
  // the ceiling instead of diluting the share.
  //
  // Write path only. A read that is throttled costs a poll, not a lead, and the
  // catalog already keeps read traffic out of every booking measurement.
  //
  // #1450 rides the same counter for the two credential facts, and each is
  // NARROWER than the error code beside it. A missing key is our own deployment;
  // a present and wrong token is a caller holding a stale one. A request carrying
  // NO credential records nothing here at all, because the endpoint is public and
  // anything crawling the internet produces those continuously: a signal built on
  // the error code would page on background noise (L36).
  const ownCounter: SelfInflictedRefusal | null = readPath
    ? null
    : reason === "throttled_key"
      ? "refused_ceiling_key"
      : reason === "throttled_ip"
        ? "refused_ceiling_ip"
        : reason === "not_configured"
          ? "refused_not_configured"
          : reason === "bad_credential" && tokenPresent
            ? "refused_key_wrong"
            : null;
  if (ownCounter) {
    recordApiOutcome(ownCounter, "", null, {
      by: "unidentifiable",
      why: "refused before any bucket or booking was read",
    });
  }
  if (counting.kind === "error") {
    // No bucket is known yet: the body has not been read. "" is the tally's
    // existing convention for an outcome recorded before routing (#418), and for
    // the same reason nothing here can say whether the caller was the smoke
    // canary, so the refusal is counted as real traffic (#1616). That is the
    // right way round: a rejected key means every lead the integration holds is
    // being refused, which is exactly what the failure rate should see.
    recordApiOutcome("error", "", counting.code, {
      by: "unidentifiable",
      why: "refused at auth, before any bucket or booking was read",
    });
  }
  log.warn("booking-api", {
    msg: "refused",
    reason,
    path: readPath ? "read" : "write",
    status,
    key: keyId ?? "none",
    counted: counting.kind === "error" ? counting.code : "no",
    own_counter: ownCounter ?? "none",
  });
  // #2243: under SLATE_LOADTEST only, the refusal carries the address the ceiling
  // was keyed on. This is the response a load run most needs it on: a 429 is the
  // one outcome a runner cannot attribute for itself.
  //
  // #2339 adds WHICH ceiling said no, from the same `reason` the log line and the
  // counter above were chosen by, so the three cannot disagree (L70). The per key
  // and the per address ceilings answer 429 through this one refusal, so without
  // it a run proving the per address ceiling counts a per key refusal as proof of
  // it, and passes a bar that ceiling never met.
  return {
    ok: false,
    reason,
    response: stampRefusedBy(
      stampSeenIp(NextResponse.json({ error }, { status }), headers),
      reason,
    ),
  };
}

/**
 * Shared bearer-auth + rate-limit gate for the key-authed booking API routes
 * (#386, extracted in #1017 so `/api/bookings` and `/api/bookings/bookable` share
 * one gate instead of drifting copies). The per-minute burst windows run at the
 * Cloudflare edge (#961, no DB round-trip), and since #3416 so do the strict hourly
 * ceilings: they are counted exactly, per request, in the same Durable Object
 * (`exactCeilingWithinLimit`), with the limits, keys, refusals and fail open
 * direction they had as Postgres rows. So nothing here reaches Supabase before the
 * confirm line, which is what a burst of a hundred confirms used to queue behind.
 * `hourlyKeyRules` selects the ceiling (writes use the default; reads pass a
 * separate ceiling so polling can't starve the booking path, #393). `readPath`
 * picks the matching edge binding, and a null `hourlyIpRules` opts reads out of
 * the per-IP backstop.
 *
 * `callers` is WHO this route admits (#2940). It defaults to every caller whose key
 * opens the whole API, so a route says nothing to keep a cancel only key out; the
 * cancel alone passes `BOOKING_API_CALLERS`. A cancel only key on any other route is
 * simply not one of that route's keys, so it is refused 401 exactly as a partner key
 * is on the smoke endpoints.
 *
 * `onAuthenticated` (#3460, #3355 item 1) runs the moment the key is known to be good,
 * BEFORE the ceilings are asked, so whatever it starts (a confirm's switch read and pool
 * grouping fetch) runs during their I/O. It never runs for a key that fails
 * authentication: a flood of bad keys buys no work beyond the refusal (L498). It DOES
 * run for a good key the ceilings then refuse with a 429, so whatever it starts must
 * cost per server and never per request; `startConfirmPrelude` states that bound. It
 * must not throw or await.
 */
export async function authorizeBookingApi<C extends BookingApiCaller = FullApiCaller>(
  req: NextRequest,
  hourlyKeyRules: RateLimitRule[] = DIRECT_BOOKING_API_HOURLY_RATE_RULES,
  hourlyIpRules: RateLimitRule[] | null = DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
  readPath = false,
  callers: readonly C[] = FULL_API_CALLERS as readonly C[],
  onAuthenticated?: () => void,
): Promise<AuthOutcome<C>> {
  const auth = authenticateBearer(req.headers.get("authorization"), configuredBookingApiKeys(callers));
  if (!auth.ok) {
    // #3142: past a minute's worth of refused credentials from one address, answer 429 and
    // skip the work a refusal otherwise buys (the retired key watch, the outcome record).
    // Asked only after the credential failed, so a caller with a good key spends nothing.
    if (auth.status === 401 && !(await bearerFailureWithinLimit(clientIp(req.headers)))) {
      return refuse(
        "throttled_credential",
        "Too many failed attempts. Try again in a minute.",
        429,
        readPath,
        req.headers,
      );
    }
    // #2879: a present token that is not one of ours may be a RETIRED key, which the
    // caller sightings cannot see because they record only successes. The watcher
    // defers everything past the response, so the refusal below is unchanged.
    if (auth.status === 401 && auth.tokenPresent) {
      watchRetiredKey(bearerToken(req.headers.get("authorization")), req.method, new URL(req.url).pathname, req.headers);
    }
    // The reason is DERIVED from the status the authenticator already decided, so
    // the classification and the response cannot disagree (L53).
    return refuse(
      refusalReasonForStatus(auth.status),
      auth.error,
      auth.status,
      readPath,
      req.headers,
      undefined,
      auth.tokenPresent,
    );
  }
  onAuthenticated?.();
  const keyBudget = "Rate limit exceeded for this API key.";
  // Per CALLER (#2645): edge per-minute burst window first (no DB round-trip), then
  // the hourly cap. Keyed on who the key belongs to, not which slot matched, so a
  // caller mid rotation does not get two budgets and one partner cannot spend
  // another's.
  const keyEdgeOk = readPath
    ? await bookingApiReadWithinLimit(auth.caller)
    : await bookingApiWriteWithinLimit(auth.caller);
  if (!keyEdgeOk || !(await exactCeilingWithinLimit({ kind: "opaque", key: `key:${auth.caller}` }, hourlyKeyRules))) {
    return refuse("throttled_key", keyBudget, 429, readPath, req.headers, auth.keyId);
  }
  // #597: a coarse per-IP backstop on top of the per-key ceiling, in its own counter.
  // The key ceiling bounds total volume; this bounds any ONE machine, so a leaked key
  // cannot spend the whole budget from a single host. Per-minute at the edge, and the
  // hourly one exact in the edge counter too (#3416).
  if (hourlyIpRules) {
    const ip = clientIp(req.headers);
    if (!(await bookingApiIpWithinLimit(ip)) || !(await exactCeilingWithinLimit(
        // #1557: an address we cannot read declines to judge here, and the per KEY ceiling
        // above (an id that came from authentication) still bounds the caller.
        { kind: "address", ip, keyPrefix: "ip:", policy: BOOKING_API_IP_LIMITER },
        hourlyIpRules,
      ))) {
      return refuse(
        "throttled_ip",
        "Rate limit exceeded for this client.",
        429,
        readPath,
        req.headers,
        auth.keyId,
      );
    }
  }
  // #2717: keep "this caller's key works, from this host" as a fact the readiness
  // gate and the admin console can read. Deferred past the response and throttled to
  // once an hour per caller and host, so a booking pays nothing for it.
  recordCallerSeen(auth.caller, req.method, req.headers);
  // The key set was built from `callers` alone, so the caller it matched is one of them.
  return { ok: true, keyId: auth.keyId, caller: auth.caller as C };
}
