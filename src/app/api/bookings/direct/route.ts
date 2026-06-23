import { NextResponse, type NextRequest } from "next/server";
import { bookingApiKeyPrimary, bookingApiKeySecondary } from "@/lib/env";
import { parseApiKeys, authenticateBearer } from "@/lib/booking/api-auth";
import { parseDirectBookingRequest } from "@/lib/booking/api-request";
import {
  bookViaApi,
  previewBooking,
  SlotUnavailableError,
  VerifyUnavailableError,
  NoEligibleAgentsError,
  UnknownBucketError,
} from "@/lib/booking/service";
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
        ? { error: parsed.error, code: "VALIDATION", fieldErrors: parsed.fieldErrors }
        : { error: parsed.error, code: "VALIDATION" },
      { status: parsed.status },
    );
  }

  const v = parsed.value;

  // Dry run (#380): report what WOULD happen, no calendar event / booking / webhook.
  if (v.dryRun) {
    try {
      const preview = await previewBooking({
        bucketCode: v.bucketCode,
        startIso: v.startIso,
        timezone: v.timezone,
        salesforceId: v.salesforceId,
        attendee: v.attendee,
        prefill: v.prefill,
        externalId: v.externalId,
        confirmReschedule: v.confirmReschedule,
      });
      return NextResponse.json(preview);
    } catch (err) {
      const { status, code } = mapBookingError(err);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Preview failed", code },
        { status },
      );
    }
  }

  try {
    const result = await bookViaApi({
      bucketCode: v.bucketCode,
      startIso: v.startIso,
      timezone: v.timezone,
      salesforceId: v.salesforceId,
      attendee: v.attendee,
      prefill: v.prefill,
      externalId: v.externalId,
      confirmReschedule: v.confirmReschedule,
    });

    const body = {
      outcome: result.outcome,
      booking: {
        id: result.booking.id,
        externalId: result.booking.external_id,
        startsAt: result.booking.starts_at,
        endsAt: result.booking.ends_at,
        status: result.booking.status,
        agent: { name: result.booking.agent_name, email: result.booking.agent_email },
        manageUrl: result.manageUrl,
      },
    };

    // The lead already has an appointment and the match wasn't strong enough to
    // move it silently — 409 so the bot asks the lead, then retries with
    // confirmReschedule:true. Everything else is a success.
    const status = result.outcome === "confirm_required" ? 409 : 200;
    return NextResponse.json(body, { status });
  } catch (err) {
    const { status, code } = mapBookingError(err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Booking failed", code },
      { status },
    );
  }
}

/**
 * Stable, machine-readable error contract (#358) so the bot can act on the
 * outcome without parsing prose: a config error (UNKNOWN_BUCKET /
 * NO_ELIGIBLE_AGENTS) means stop retrying and escalate; SLOT_TAKEN means pick
 * another slot; VERIFY_UNAVAILABLE is transient (retry); INTERNAL is unexpected.
 */
function mapBookingError(err: unknown): {
  status: number;
  code: "UNKNOWN_BUCKET" | "NO_ELIGIBLE_AGENTS" | "SLOT_TAKEN" | "VERIFY_UNAVAILABLE" | "INTERNAL";
} {
  if (err instanceof UnknownBucketError) return { status: 422, code: "UNKNOWN_BUCKET" };
  if (err instanceof NoEligibleAgentsError) return { status: 409, code: "NO_ELIGIBLE_AGENTS" };
  if (err instanceof SlotUnavailableError) return { status: 409, code: "SLOT_TAKEN" };
  if (err instanceof VerifyUnavailableError) return { status: 503, code: "VERIFY_UNAVAILABLE" };
  return { status: 500, code: "INTERNAL" };
}
