import { NextResponse, type NextRequest } from "next/server";
import { bookingApiKeyPrimary, bookingApiKeySecondary } from "@/lib/env";
import { parseApiKeys, authenticateBearer } from "@/lib/booking/api-auth";
import { parseDirectBookingRequest } from "@/lib/booking/api-request";
import { allowRequest } from "@/lib/rate-limit";
import { DIRECT_BOOKING_API_RATE_RULES } from "@/lib/rate-limit-core";

export const dynamic = "force-dynamic";

/**
 * Direct booking API (#253/#250, milestone #2). A key-authed endpoint the
 * external AI auto-booker calls to create a fully-routed booking server-side,
 * retiring the headless cal.com/embed scraping it does today.
 *
 * Phase 1 (#355) is the authenticated SKELETON: two-key bearer auth (so the
 * secret rotates with zero downtime), a generous per-key rate ceiling, and
 * per-call key attribution. The request body — schema/validation (#356),
 * person-level dedupe + auto-reschedule (#357), and the machine-readable error
 * contract (#358) — lands in later phases, so a valid call returns 501 for now.
 *
 *   POST (Bearer BOOKING_API_KEY[_2]) -> 501 | 401 | 429 | 503
 */
export async function POST(req: NextRequest) {
  const keys = parseApiKeys(bookingApiKeyPrimary(), bookingApiKeySecondary());
  const auth = authenticateBearer(req.headers.get("authorization"), keys);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // Per-KEY ceiling (not per-IP): one bot behind one IP legitimately does
  // ~2000/day. Generous runaway/leaked-key backstop; fails open (allowRequest).
  if (!(await allowRequest(`key:${auth.keyId}`, DIRECT_BOOKING_API_RATE_RULES))) {
    return NextResponse.json(
      { error: "Rate limit exceeded for this API key." },
      { status: 429 },
    );
  }

  // Attribution: which key served the call (the label, never the secret).
  console.log(`booking-api: authenticated request via key '${auth.keyId}'`);

  const parsed = parseDirectBookingRequest(await req.json().catch(() => null));
  if (!parsed.ok) {
    return NextResponse.json(
      parsed.fieldErrors
        ? { error: parsed.error, fieldErrors: parsed.fieldErrors }
        : { error: parsed.error },
      { status: parsed.status },
    );
  }

  // Body validated. The booking itself — person-level dedupe + auto-reschedule
  // (#357) and the machine-readable success/error contract (#358) — is next.
  return NextResponse.json(
    { error: "Not implemented yet.", code: "NOT_IMPLEMENTED" },
    { status: 501 },
  );
}
