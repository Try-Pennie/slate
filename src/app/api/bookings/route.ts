import { NextResponse, type NextRequest } from "next/server";
import { bookingApiKeyPrimary, bookingApiKeySecondary } from "@/lib/env";
import { parseApiKeys, authenticateBearer } from "@/lib/booking/api-auth";
import { parseDirectBookingRequest, parseLookupQuery, parseCancelQuery, parseListQuery, LIST_ONLY_PARAMS } from "@/lib/booking/api-request";
import {
  bookViaApi,
  previewBooking,
  lookupPersonBookings,
  getPersonBookingById,
  cancelDirectBooking,
  listBookings,
  SlotUnavailableError,
  VerifyUnavailableError,
  NoEligibleAgentsError,
  UnknownBucketError,
  BookingNotFoundError,
} from "@/lib/booking/service";
import { allowRequest } from "@/lib/rate-limit";
import { DIRECT_BOOKING_API_RATE_RULES } from "@/lib/rate-limit-core";

export const dynamic = "force-dynamic";

type AuthOutcome =
  | { ok: true; keyId: "primary" | "secondary" }
  | { ok: false; response: NextResponse };

/** Shared auth + per-key rate-limit gate for every method on this route (#386). */
async function authorize(req: NextRequest): Promise<AuthOutcome> {
  const keys = parseApiKeys(bookingApiKeyPrimary(), bookingApiKeySecondary());
  const auth = authenticateBearer(req.headers.get("authorization"), keys);
  if (!auth.ok) {
    return { ok: false, response: NextResponse.json({ error: auth.error }, { status: auth.status }) };
  }
  if (!(await allowRequest(`key:${auth.keyId}`, DIRECT_BOOKING_API_RATE_RULES))) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Rate limit exceeded for this API key." },
        { status: 429 },
      ),
    };
  }
  return { ok: true, keyId: auth.keyId };
}

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
  const authd = await authorize(req);
  if (!authd.ok) return authd.response;
  console.log(`booking-api: authenticated request via key '${authd.keyId}'`);

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
 * Lookup (#386) + List (#392). No `externalId` key → list mode (paginated,
 * cross-person); `externalId` present → per-person lookup. Rejects blank
 * externalId and list filters mixed into a lookup request.
 */
export async function GET(req: NextRequest) {
  const authd = await authorize(req);
  if (!authd.ok) return authd.response;

  const sp = new URL(req.url).searchParams;
  const externalIdKeyPresent = sp.has("externalId");

  // List mode: the externalId KEY is absent entirely.
  if (!externalIdKeyPresent) {
    const parsed = parseListQuery(sp);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error, code: "VALIDATION" }, { status: 400 });
    }
    const { bookings, nextCursor } = await listBookings(parsed.value).then((r) => ({
      bookings: r.items,
      nextCursor: r.nextCursor,
    }));
    return NextResponse.json({ bookings, nextCursor });
  }

  // Lookup mode: externalId present. Reject blank, and reject list filters mixed in.
  if ((sp.get("externalId") ?? "").trim() === "") {
    return NextResponse.json({ error: "externalId is required", code: "VALIDATION" }, { status: 400 });
  }
  if (LIST_ONLY_PARAMS.some((k) => sp.has(k))) {
    return NextResponse.json(
      { error: "externalId selects per-person lookup; remove list filters or omit externalId", code: "VALIDATION" },
      { status: 400 },
    );
  }

  const parsed = parseLookupQuery(sp);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, code: "VALIDATION" }, { status: 400 });
  }
  const { externalId, salesforceId, bookingId, status } = parsed.value;
  try {
    if (bookingId) {
      const booking = await getPersonBookingById({ bookingId, identity: { externalId, salesforceId }, status });
      return NextResponse.json({ booking });
    }
    const list = await lookupPersonBookings({ externalId, salesforceId });
    return NextResponse.json({ bookings: list });
  } catch (err) {
    const { httpStatus, code } = mapLookupError(err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Lookup failed", code },
      { status: httpStatus },
    );
  }
}

/**
 * Cancel one booking by id (#386). Requires `bookingId` + a strong id; cancels
 * only if the booking is owned and active, else 404 NOT_FOUND.
 */
export async function DELETE(req: NextRequest) {
  const authd = await authorize(req);
  if (!authd.ok) return authd.response;

  const parsed = parseCancelQuery(req.nextUrl.searchParams);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, code: "VALIDATION" }, { status: 400 });
  }
  const { bookingId, externalId, salesforceId, reason } = parsed.value;

  try {
    const booking = await cancelDirectBooking({
      bookingId,
      identity: { externalId, salesforceId },
      reason,
    });
    return NextResponse.json({ outcome: "cancelled", booking });
  } catch (err) {
    const { httpStatus, code } = mapLookupError(err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Cancel failed", code },
      { status: httpStatus },
    );
  }
}

/** Error→code map for the lookup/cancel paths (#386): a missing/unowned booking
 *  is NOT_FOUND; anything else is an unexpected INTERNAL. */
function mapLookupError(err: unknown): {
  httpStatus: number;
  code: "NOT_FOUND" | "INTERNAL";
} {
  if (err instanceof BookingNotFoundError) return { httpStatus: 404, code: "NOT_FOUND" };
  return { httpStatus: 500, code: "INTERNAL" };
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
