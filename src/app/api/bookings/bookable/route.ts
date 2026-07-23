import { NextResponse, type NextRequest } from "next/server";
import { authorizeBookingApi } from "@/lib/booking/route-auth";
import {
  BOOKABLE_CHECK_HOURLY_RATE_RULES,
  DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
} from "@/lib/rate-limit-core";
import { checkBookable, UnknownBucketError, VerifyUnavailableError } from "@/lib/booking/service";
import { getDefaultBucketCode } from "@/lib/booking/settings";
import { GENERIC_ERROR_MESSAGE, reportInternalError } from "@/lib/api/errors";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Validate-only "is this time bookable?" check (#541/#1017). The direct-booking
 * bot asks whether a given bucket + time could be booked BEFORE it collects the
 * lead's details, so it never shows a lead a slot that then fails at confirm.
 *
 * Key-authed (same bearer keys as POST /api/bookings), identity-free (no lead,
 * no dedupe). It runs the REAL per-slot routing (round-robin + verify-on-book,
 * cascading the debt-tier ladder) with writes disabled, so the answer can never
 * disagree with an actual book. A busy ladder is a normal 200 `bookable:false`;
 * a transient verify outage is 503 (NEVER a false "no"); an unknown/hidden bucket
 * is 422; no bucketCode and no configured default is 400 NO_DEFAULT_BUCKET.
 *
 * Its own modest per-key ceiling (~200/hr) plus the shared per-IP backstop, NOT
 * the ~30k/hr status-poll read budget: each call is a full routing pass.
 *
 *   GET ?bucketCode=&startIso=&timezone= (Bearer) -> 200 | 400 | 401 | 422 | 429 | 503 | 500
 */
export async function GET(req: NextRequest) {
  const authd = await authorizeBookingApi(
    req,
    BOOKABLE_CHECK_HOURLY_RATE_RULES,
    DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
    true,
  );
  if (!authd.ok) return authd.response;

  const sp = new URL(req.url).searchParams;
  const startIso = (sp.get("startIso") ?? "").trim();
  if (!startIso || !Number.isFinite(Date.parse(startIso))) {
    return NextResponse.json(
      { error: "startIso is required and must be an ISO 8601 date-time", code: "VALIDATION" },
      { status: 400 },
    );
  }

  // No bucketCode -> fall back to the admin-configured default (#1015/#1016).
  // Neither present is a config error the caller must fix, not a silent guess.
  let bucketCode = (sp.get("bucketCode") ?? "").trim();
  if (!bucketCode) {
    const fallback = await getDefaultBucketCode();
    if (!fallback) {
      return NextResponse.json(
        {
          error: "No bucketCode was provided and no default booking bucket is configured.",
          code: "NO_DEFAULT_BUCKET",
        },
        { status: 400 },
      );
    }
    bucketCode = fallback;
  }

  try {
    const result = await checkBookable({ bucketCode, startIso, allowTestBuckets: false });
    log.info("bookable-check", {
      msg: "outcome",
      bucket: bucketCode,
      key: authd.keyId,
      bookable: result.bookable,
      reason: result.reason,
      tier_fallback: result.tierFallback,
    });
    return NextResponse.json({
      bookable: result.bookable,
      reason: result.reason,
      requestedBucketCode: bucketCode,
      effectiveBucketCode: result.effectiveBucketCode,
      tierFallback: result.tierFallback,
      rungsDropped: result.rungsDropped,
      wouldAssign: result.wouldAssign,
      alternatives: result.alternatives,
    });
  } catch (err) {
    // Unknown/hidden bucket: the caller must fix the code (422). A transient verify
    // outage: retryable (503), NEVER downgraded to a confident "not bookable".
    if (err instanceof UnknownBucketError) {
      return NextResponse.json({ error: "Unknown bucket", code: "UNKNOWN_BUCKET" }, { status: 422 });
    }
    if (err instanceof VerifyUnavailableError) {
      return NextResponse.json(
        { error: "Availability could not be verified right now; retry shortly.", code: "VERIFY_UNAVAILABLE" },
        { status: 503 },
      );
    }
    await reportInternalError(err, "bookings-api/bookable");
    return NextResponse.json({ error: GENERIC_ERROR_MESSAGE, code: "INTERNAL" }, { status: 500 });
  }
}
