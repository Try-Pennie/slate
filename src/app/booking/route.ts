import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  createBooking,
  findDuplicateBookingWarning,
  ExistingCallError,
  SlotUnavailableError,
  VerifyUnavailableError,
  NoEligibleAgentsError,
} from "@/lib/booking/service";
import { validateAttendee } from "@/lib/attendee";
import { HONEYPOT_FIELD, honeypotTripped } from "@/lib/booking/honeypot";
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
  contactRateKeys,
  BOOKING_HOURLY_RATE_RULES,
  BOOKING_CONTACT_HOURLY_RATE_RULES,
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
  const tooMany = (scope: "edge-minute" | "hourly" | "contact") => {
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

  const raw = await req.json().catch(() => null);

  // Honeypot (#1033): a hidden decoy field a real user never sees or fills, so a
  // value here means a scripted bot filling every field. Reject with the SAME
  // generic 400 a schema failure returns (revealing nothing bot-specific), before
  // touching the booking path. Logged at a queryable tag so trips are observable;
  // a honeypot hit is expected background noise, so it does NOT alert.
  if (raw && typeof raw === "object" && honeypotTripped((raw as Record<string, unknown>)[HONEYPOT_FIELD])) {
    log.info("booking-honeypot", { msg: "tripped", ip });
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const parsed = schema.safeParse(raw);
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

  // Per-contact hourly cap (#1033), keyed on the attendee identity rather than the
  // IP: a distributed bot spreading fake bookings across many IPs is bounded by
  // the fake identity it reuses. Checked AFTER attendee validation (so email/phone
  // are present and valid) and after the per-IP caps. Refunded on a verify outage
  // below, exactly like the IP hourly cap, so a server fault never burns a real
  // lead's contact budget.
  const contactKeys = contactRateKeys({
    email: parsed.data.attendee.email,
    phone: parsed.data.attendee.phone,
  });
  for (const key of contactKeys) {
    if (!(await allowRequest(key, BOOKING_CONTACT_HOURLY_RATE_RULES))) return tooMany("contact");
  }

  // Give back the IP cap AND the per-contact caps for a failure that ISN'T the
  // lead's doing, so a server outage or a lost slot race can't consume their
  // booking budget. The edge per-minute window has no refund path, but it's a
  // short burst that clears within a minute.
  const refundAll = async () => {
    await refundRequest(ip, BOOKING_HOURLY_RATE_RULES);
    for (const key of contactKeys) {
      await refundRequest(key, BOOKING_CONTACT_HOURLY_RATE_RULES);
    }
  };

  try {
    const { booking, manageUrl } = await createBooking({
      // One call per person, enforced here and only here (#1337): the direct
      // booking API owns its own richer decision and must keep creating on a
      // cross-bucket rebook (#364).
      refuseIfPersonHasCall: true,
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
    // Backstop, not the ordinary path (#1337): a second booking is normally
    // DECLINED above before anything is created. This still fires for the window
    // refusal cannot cover, namely a failed existing-call lookup (which books
    // rather than refusing) and two simultaneous confirms that both pass the
    // check. When a duplicate does reach here, the lead is told about it (#626).
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
    // The lead already has an active call, so nothing was created (#1337). Refund
    // the rate-limit hit: being declined is not an attempt they should pay for,
    // and the Move they are about to make is a separate request.
    if (err instanceof ExistingCallError) {
      await refundAll();
      return NextResponse.json({ existingCall: err.existingCall }, { status: 409 });
    }
    // Couldn't verify any candidate (likely a Google/DB outage), not a full
    // slot — tell the lead it's temporary and let them retry (#319). Refund the
    // rate-limit hit: a server-side outage must not burn their booking budget.
    if (err instanceof VerifyUnavailableError) {
      // Couldn't verify any candidate (a Google/DB outage), not the lead's fault.
      await refundAll();
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    // A genuinely-full slot: someone else took it a moment earlier. Not the lead's
    // fault, and a retry against another slot may well succeed, so hand the budget
    // back (#1089) before surfacing "no times" (409).
    if (err instanceof SlotUnavailableError) {
      await refundAll();
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    // An empty/misconfigured pool ALSO surfaces as "no times" (409) to the consumer
    // (the API route #358 distinguishes them), but it is a config problem, not a
    // slot race: a retry won't help, so we deliberately do NOT refund here.
    if (err instanceof NoEligibleAgentsError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return internalErrorResponse(err, "booking");
  }
}
