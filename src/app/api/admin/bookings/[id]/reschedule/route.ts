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
import {
  AttendeeEmailRefusedError,
  ATTENDEE_EMAIL_REFUSED_STAFF_ANSWER,
} from "@/lib/booking/attendee-email-refused";
import { validateReason } from "@/lib/booking/core";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { internalErrorResponse } from "@/lib/api/errors";
import { answerTimed, noteRefusal, type ConfirmLineFacts } from "@/lib/booking/confirm-latency";
import { crossOriginRefusal } from "@/lib/api/same-origin";

export const dynamic = "force-dynamic";

const schema = z.object({
  start: z.string().min(1),
  reason: z.string().optional(),
  reasonDetail: z.string().optional(),
});

/**
 * Admin reschedule by booking id (#326). Manager+ gated (#544); initiator='admin'.
 *
 * #3401: answered through the same `confirm answered` line a booking writes,
 * saying it was a staff move, so its wait is measurable and a slow or timed out
 * one carries the stage profile (#3300). This route runs under no confirm budget,
 * so no call is reported to the profile and its line carries no call counts.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const facts: ConfirmLineFacts = {};
  return answerTimed("booking", () => handlePost(req, ctx, facts), { facts, kind: "admin_move" });
}

async function handlePost(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
  facts: ConfirmLineFacts,
) {
  const endChecks = facts.profile?.begin("route-checks");
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

  endChecks?.();
  try {
    const { booking } = await adminRescheduleBooking(id, parsed.data.start, reason.reason, actor, facts);
    return NextResponse.json({
      id: booking.id,
      startsAt: booking.starts_at,
      status: booking.status,
    });
  } catch (err) {
    // #3300: a timeout, said on the line with the profile and the lead.
    noteRefusal(facts, err);
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
    // #3373: Google refused to invite the lead's stored address, so the move's
    // invite was never written and the booking is where it was. The same staff
    // answer the reassign routes give, never the generic 500.
    if (err instanceof AttendeeEmailRefusedError) {
      return NextResponse.json(ATTENDEE_EMAIL_REFUSED_STAFF_ANSWER.body, {
        status: ATTENDEE_EMAIL_REFUSED_STAFF_ANSWER.status,
      });
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
