import { stampSeenIp, stampRefusedBy } from "@/lib/loadtest-echo";
import { NextResponse, type NextRequest } from "next/server";
import { configuredBookingApiKeys } from "@/lib/booking/api-keys";
import {
  type ApiKey,
  type AuthRefusalReason,
  type BookingApiCaller,
  authRefusalCounting,
  authenticateBearer,
  refusalReasonForStatus,
} from "@/lib/booking/api-auth";
import { recordApiOutcome } from "@/lib/monitor/record-api-outcome";
import type { SelfInflictedRefusal } from "@/lib/monitor/booking-api-outcome";
import { log } from "@/lib/log";
import {
  allowRequest,
  clientIp,
  bookingApiWriteWithinLimit,
  bookingApiReadWithinLimit,
  bookingApiIpWithinLimit,
} from "@/lib/rate-limit";
import { BOOKING_API_IP_LIMITER } from "@/lib/rate-limit-core";
import {
  DIRECT_BOOKING_API_HOURLY_RATE_RULES,
  DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
} from "@/lib/rate-limit-core";
import type { RateLimitRule } from "@/lib/rate-limit-core";

export type AuthOutcome =
  /** #2645: `caller` is who the key belongs to, `keyId` which of its slots. */
  | { ok: true; keyId: ApiKey["id"]; caller: BookingApiCaller }
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
): AuthOutcome {
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
 * Cloudflare edge (#961, no DB round-trip); the strict hourly ceilings stay in the
 * DB. `hourlyKeyRules` selects the ceiling (writes use the default; reads pass a
 * separate ceiling so polling can't starve the booking path, #393). `readPath`
 * picks the matching edge binding, and a null `hourlyIpRules` opts reads out of
 * the per-IP backstop.
 */
export async function authorizeBookingApi(
  req: NextRequest,
  hourlyKeyRules: RateLimitRule[] = DIRECT_BOOKING_API_HOURLY_RATE_RULES,
  hourlyIpRules: RateLimitRule[] | null = DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
  readPath = false,
): Promise<AuthOutcome> {
  const auth = authenticateBearer(req.headers.get("authorization"), configuredBookingApiKeys());
  if (!auth.ok) {
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
  const keyBudget = "Rate limit exceeded for this API key.";
  // Per CALLER (#2645): edge per-minute burst window first (no DB round-trip), then
  // the hourly cap. Keyed on who the key belongs to, not which slot matched, so a
  // caller mid rotation does not get two budgets and one partner cannot spend
  // another's.
  const keyEdgeOk = readPath
    ? await bookingApiReadWithinLimit(auth.caller)
    : await bookingApiWriteWithinLimit(auth.caller);
  if (!keyEdgeOk || !(await allowRequest({ kind: "opaque", key: `key:${auth.caller}` }, hourlyKeyRules))) {
    return refuse("throttled_key", keyBudget, 429, readPath, req.headers, auth.keyId);
  }
  // #597: a coarse per-IP backstop on top of the per-key ceiling, in its own counter.
  // The key ceiling bounds total volume; this bounds any ONE machine, so a leaked key
  // cannot spend the whole budget from a single host. Per-minute at the edge, hourly in DB.
  if (hourlyIpRules) {
    const ip = clientIp(req.headers);
    if (!(await bookingApiIpWithinLimit(ip)) || !(await allowRequest(
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
  return { ok: true, keyId: auth.keyId, caller: auth.caller };
}
