import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createBooking, SlotUnavailableError } from "@/lib/booking/service";
import { validateAttendee } from "@/lib/attendee";

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
    return NextResponse.json({
      id: booking.id,
      startsAt: booking.starts_at,
      endsAt: booking.ends_at,
      manageUrl,
    });
  } catch (err) {
    if (err instanceof SlotUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Booking failed" },
      { status: 500 },
    );
  }
}
