import { NextResponse, type NextRequest } from "next/server";
import { bookingApiKeyPrimary, bookingApiKeySecondary } from "@/lib/env";
import {
  type AuthRefusalReason,
  authRefusalCounting,
  authenticateBearer,
  parseApiKeys,
  refusalReasonForStatus,
} from "@/lib/booking/api-auth";
import { recordApiOutcome } from "@/lib/monitor/record-api-outcome";
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
  | { ok: true; keyId: "primary" | "secondary" }
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
  keyId?: "primary" | "secondary",
): AuthOutcome {
  const counting = authRefusalCounting(reason, readPath ? "read" : "write");
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
  });
  return { ok: false, reason, response: NextResponse.json({ error }, { status }) };
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
  const keys = parseApiKeys(bookingApiKeyPrimary(), bookingApiKeySecondary());
  const auth = authenticateBearer(req.headers.get("authorization"), keys);
  if (!auth.ok) {
    // The reason is DERIVED from the status the authenticator already decided, so
    // the classification and the response cannot disagree (L53).
    return refuse(refusalReasonForStatus(auth.status), auth.error, auth.status, readPath);
  }
  const keyBudget = "Rate limit exceeded for this API key.";
  // Per-key: edge per-minute burst window first (no DB round-trip), then the hourly cap.
  const keyEdgeOk = readPath
    ? await bookingApiReadWithinLimit(auth.keyId)
    : await bookingApiWriteWithinLimit(auth.keyId);
  if (!keyEdgeOk || !(await allowRequest({ kind: "opaque", key: `key:${auth.keyId}` }, hourlyKeyRules))) {
    return refuse("throttled_key", keyBudget, 429, readPath, auth.keyId);
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
        auth.keyId,
      );
    }
  }
  return { ok: true, keyId: auth.keyId };
}
