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
  allowRequest,
  refundRequest,
  clientIp,
  BOOKING_RATE_RULES,
} from "@/lib/rate-limit";
import { internalErrorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const schema = z.object({
  bucketCode: z.string().min(1),
  start: z.string().min(1), // ISO instant of the chosen slot
  timezone: z.string().min(1),
  salesforceId: z.string().nullish(),
  // Field-level rules live in validateAttendee (shared with the Booker form).
  attendee: z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
  }),
  prefill: z.record(z.string(), z.string()).default({}),
});

export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);
  if (!(await allowRequest(ip, BOOKING_RATE_RULES))) {
    return NextResponse.json(
      { error: "Too many booking attempts from your network. Please try again in a few minutes." },
      { status: 429 },
    );
  }

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
      await refundRequest(ip, BOOKING_RATE_RULES);
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
