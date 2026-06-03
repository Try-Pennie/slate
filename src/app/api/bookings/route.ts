import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createBooking, SlotUnavailableError } from "@/lib/booking/service";

export const dynamic = "force-dynamic";

const schema = z.object({
  bucketCode: z.string().min(1),
  start: z.string().min(1), // ISO instant of the chosen slot
  timezone: z.string().min(1),
  salesforceId: z.string().nullish(),
  attendee: z.object({
    name: z.string().optional(),
    email: z.string().email().optional(),
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

  try {
    const { booking, manageUrl } = await createBooking({
      bucketCode: parsed.data.bucketCode,
      startIso: parsed.data.start,
      timezone: parsed.data.timezone,
      salesforceId: parsed.data.salesforceId ?? null,
      attendee: parsed.data.attendee,
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
