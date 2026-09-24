import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireBookingActor } from "@/lib/auth";
import { forbiddenResponse } from "@/lib/auth/http";
import {
  adminRescheduleBooking,
  SlotUnavailableError,
  RescheduleConflictError,
  VerifyUnavailableError,
  RescheduleLockUnavailableError,
  NoEligibleAgentsError,
  OutsideCallingWindowError,
} from "@/lib/booking/service";
import { callingWindowLabel } from "@/lib/booking/lead-calling-window";
import { validateReason } from "@/lib/booking/core";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { internalErrorResponse } from "@/lib/api/errors";
import { crossOriginRefusal } from "@/lib/api/same-origin";

export const dynamic = "force-dynamic";

const schema = z.object({
  start: z.string().min(1),
  reason: z.string().optional(),
  reasonDetail: z.string().optional(),
});

/** Admin reschedule by booking id (#326). Manager+ gated (#544); initiator='admin'. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // #1046: this route's only credential is the session cookie, so refuse a request
  // that says it came from somewhere else, before the auth check and before the body
  // is read. See src/lib/api/same-origin.ts for why silence is allowed through.
  const crossOrigin = crossOriginRefusal(req, "admin/bookings/[id]/reschedule");
  if (crossOrigin) return crossOrigin;

  let actor: Awaited<ReturnType<typeof requireBookingActor>>;
  try {
    actor = await requireBookingActor();
  } catch (err) {
    return forbiddenResponse(err);
  }
  const { id } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const reasonOptions = await loadReasonOptions();
  const reason = validateReason(
    { code: parsed.data.reason, detail: parsed.data.reasonDetail },
    reasonOptions.reschedule.selectable,
  );
  if (!reason.ok) {
    return NextResponse.json({ error: reason.error }, { status: 400 });
  }

  try {
    const { booking } = await adminRescheduleBooking(id, parsed.data.start, reason.reason, actor);
    return NextResponse.json({
      id: booking.id,
      startsAt: booking.starts_at,
      status: booking.status,
    });
  } catch (err) {
    // #2310: the new time is outside the LEAD's calling window, judged in the
    // zone the booking was made in (not the admin's own). Named, so a manager
    // moving a Honolulu lead's call knows why 9am Eastern was refused.
    if (err instanceof OutsideCallingWindowError) {
      const { from, to } = callingWindowLabel();
      return NextResponse.json(
        {
          error: `That time is outside the lead's calling hours, ${from} to ${to} in ${err.zone}. Pick another time.`,
          code: "OUTSIDE_CALLING_WINDOW",
        },
        { status: 422 },
      );
    }
    if (err instanceof VerifyUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    // Fail-closed lock claim on a transient DB error (#479): retryable, so 503.
    if (err instanceof RescheduleLockUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    // A concurrent reschedule moved this booking under us (#439): 409 + a distinct
    // refresh message.
    if (err instanceof RescheduleConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof SlotUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    // No free agent in the bucket at the target time (#484): a full slot, not a
    // crash. 409 like the other unavailable cases.
    if (err instanceof NoEligibleAgentsError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return internalErrorResponse(err, "admin/bookings/[id]/reschedule");
  }
}
