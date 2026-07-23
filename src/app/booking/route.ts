import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  createBooking,
  findDuplicateBookingWarning,
  SlotUnavailableError,
  VerifyUnavailableError,
  NoEligibleAgentsError,
} from "@/lib/booking/service";
import { validateAttendee } from "@/lib/attendee";
import {
  bucketCodeSchema,
  startSchema,
  timezoneSchema,
  salesforceIdSchema,
  prefillSchema,
} from "@/lib/booking/input-schema";
import {
  allowRequest,
  refundRequest,
  bookingWithinLimit,
  clientIp,
  BOOKING_HOURLY_RATE_RULES,
} from "@/lib/rate-limit";
import { internalErrorResponse } from "@/lib/api/errors";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const schema = z.object({
  // Bounded, shared with the API parser so the size caps can't drift (#1034).
  bucketCode: bucketCodeSchema,
  start: startSchema, // ISO instant of the chosen slot
  timezone: timezoneSchema,
  salesforceId: salesforceIdSchema.nullish(),
  // Field-level rules live in validateAttendee (shared with the Booker form),
  // which also enforces the contact length cap.
  attendee: z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
  }),
  prefill: prefillSchema,
});

export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);
  // Light monitoring (#962): the edge per-minute window has no refund path, so a
  // transient server outage (503) still consumes one of the lead's 3/min (the
  // hourly DB cap is refunded on an outage; see the catch below). A block is
  // normally a spammy visitor, so it is deliberately NOT alerted (that would be
  // noise). But every booking 429 is logged with its scope + IP at a queryable
  // tag/level, so a too-tight limit surfaces: a cluster of edge-minute 429s from
  // many distinct IPs (rather than one flooding host) is the signal to revisit
  // 3/min. The hourly 10/hr cap already bounds sustained abuse, so the per-minute
  // window only shapes bursts.
  const tooMany = (scope: "edge-minute" | "hourly") => {
    log.info("booking-rate-limit", { msg: "throttled", scope, ip });
    return NextResponse.json(
      { error: "Too many booking attempts from your network. Please try again in a few minutes." },
      { status: 429 },
    );
  };
  // Per-minute burst window at the edge (#237): in-datacenter, no DB round-trip,
  // so it doesn't add latency to the Confirm tap. Checked first so a flood is
  // shed before we touch Postgres.
  if (!(await bookingWithinLimit(ip))) return tooMany("edge-minute");
  // Strict hourly anti-spam cap stays in the DB (a 1-hour window the native
  // binding can't express).
  if (!(await allowRequest(ip, BOOKING_HOURLY_RATE_RULES))) return tooMany("hourly");

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const attendeeErrors = validateAttendee(parsed.data.attendee);
  if (Object.keys(attendeeErrors).length > 0) {
    return NextResponse.json(
      { error: "Please check your contact details.", fieldErrors: attendeeErrors },
      { status: 400 },
    );
  }

  try {
    const { booking, manageUrl } = await createBooking({
      bucketCode: parsed.data.bucketCode,
      startIso: parsed.data.start,
      timezone: parsed.data.timezone,
      salesforceId: parsed.data.salesforceId ?? null,
      attendee: {
        name: parsed.data.attendee.name?.trim(),
        email: parsed.data.attendee.email?.trim(),
        phone: parsed.data.attendee.phone?.trim(),
      },
      prefill: parsed.data.prefill,
    });
    // A successful confirm that timed out client-side then got rebooked at a new
    // time leaves the lead with two active calls (#626). Surface their other
    // active booking so the confirmation screen can offer to view/cancel it.
    const duplicateWarning = await findDuplicateBookingWarning({
      excludeBookingId: booking.id,
      salesforceId: parsed.data.salesforceId ?? null,
      attendee: {
        email: parsed.data.attendee.email?.trim(),
        phone: parsed.data.attendee.phone?.trim(),
      },
    });

    return NextResponse.json({
      id: booking.id,
      startsAt: booking.starts_at,
      endsAt: booking.ends_at,
      manageUrl,
      duplicateWarning,
    });
  } catch (err) {
    // Couldn't verify any candidate (likely a Google/DB outage), not a full
    // slot — tell the lead it's temporary and let them retry (#319). Refund the
    // rate-limit hit: a server-side outage must not burn their booking budget.
    if (err instanceof VerifyUnavailableError) {
      // Refund only the hourly DB cap; the edge per-minute window can't be
      // refunded, but it's a short burst window, so a retry after the outage
      // clears within a minute.
      await refundRequest(ip, BOOKING_HOURLY_RATE_RULES);
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    // A genuinely-full slot OR an empty/misconfigured pool both surface to the
    // consumer as "no times" (409); the API route (#358) distinguishes them.
    if (err instanceof SlotUnavailableError || err instanceof NoEligibleAgentsError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return internalErrorResponse(err, "booking");
  }
}
