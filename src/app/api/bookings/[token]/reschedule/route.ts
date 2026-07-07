import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  rescheduleBooking,
  SlotUnavailableError,
  RescheduleConflictError,
  VerifyUnavailableError,
  NoEligibleAgentsError,
} from "@/lib/booking/service";
import { validateReason } from "@/lib/booking/core";
import { internalErrorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const schema = z.object({
  start: z.string().min(1),
  reason: z.string().optional(),
  reasonDetail: z.string().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Reason is mandatory (#326) — server-enforced, not just in the UI.
  const reason = validateReason("reschedule", {
    code: parsed.data.reason,
    detail: parsed.data.reasonDetail,
  });
  if (!reason.ok) {
    return NextResponse.json({ error: reason.error }, { status: 400 });
  }

  try {
    const { booking, manageUrl } = await rescheduleBooking(
      token,
      parsed.data.start,
      reason.reason,
      "customer",
    );
    return NextResponse.json({
      id: booking.id,
      startsAt: booking.starts_at,
      endsAt: booking.ends_at,
      manageUrl,
    });
  } catch (err) {
    // Outage (couldn't verify), not a full slot — retryable (#319).
    if (err instanceof VerifyUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    // A concurrent reschedule moved this booking under us (#439). 409 like a slot
    // conflict; the distinct message tells the actor to refresh.
    if (err instanceof RescheduleConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof SlotUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    // The target time has no free agent in the bucket (#484): a legitimately
    // full slot, not a crash. 409 like the other unavailable cases so the caller
    // can offer another time instead of seeing a generic error.
    if (err instanceof NoEligibleAgentsError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return internalErrorResponse(err, "bookings/[token]/reschedule");
  }
}
