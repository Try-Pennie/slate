import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  rescheduleBooking,
  SlotUnavailableError,
  RescheduleConflictError,
  VerifyUnavailableError,
  RescheduleLockUnavailableError,
  NoEligibleAgentsError,
} from "@/lib/booking/service";
import { validateReason } from "@/lib/booking/core";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { recordApiOutcome } from "@/lib/monitor/record-api-outcome";
import { internalErrorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const schema = z.object({
  // A parseable ISO instant (the booker sends slot starts as UTC `...Z` strings).
  // Reject garbage here so it can't reach bookingWindow's `new Date().toISOString()`,
  // which throws a RangeError on invalid input and surfaces as a generic 500 (#622).
  start: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Invalid start"),
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
    // refusal: reschedule_invalid_request
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Reason is mandatory (#326), server-enforced, not just in the UI. Validate
  // against the live option set (active + retired, #346) so an admin-added code
  // is accepted and an in-flight submission for a just-retired code still confirms.
  const reasonOptions = await loadReasonOptions();
  const reason = validateReason(
    { code: parsed.data.reason, detail: parsed.data.reasonDetail },
    reasonOptions.reschedule.all,
  );
  if (!reason.ok) {
    // refusal: reschedule_invalid_reason
    return NextResponse.json({ error: reason.error }, { status: 400 });
  }

  try {
    const { booking, manageUrl } = await rescheduleBooking(
      token,
      parsed.data.start,
      reason.reason,
      "customer",
    );
    // A lead moving their own call is a booking ATTEMPT, and its refusals below are
    // counted (#1318). The success has to be counted with them or the share stops being
    // a share: adding only the failures would inflate the very number #1313 pages on.
    // Not bucket scoped, because reaching the code here would cost a lookup the manage
    // page has no other reason to do, and the tally coalesces a missing bucket to "".
    recordApiOutcome("rescheduled", "", null);
    return NextResponse.json({
      id: booking.id,
      startsAt: booking.starts_at,
      endsAt: booking.ends_at,
      manageUrl,
    });
  } catch (err) {
    // Outage (couldn't verify), not a full slot — retryable (#319).
    if (err instanceof VerifyUnavailableError) {
      recordApiOutcome("error", "", "reschedule_verify_unavailable");
      // refusal: reschedule_verify_unavailable
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    // Fail-closed lock claim on a transient DB error (#479): safe to retry, so a
    // 503 like a verify outage, not a hard 500.
    if (err instanceof RescheduleLockUnavailableError) {
      recordApiOutcome("error", "", "reschedule_lock_unavailable");
      // refusal: reschedule_lock_unavailable
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    // A concurrent reschedule moved this booking under us (#439). 409 like a slot
    // conflict; the distinct message tells the actor to refresh.
    if (err instanceof RescheduleConflictError) {
      recordApiOutcome("error", "", "reschedule_conflict");
      // refusal: reschedule_conflict
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof SlotUnavailableError) {
      recordApiOutcome("error", "", "reschedule_slot_taken");
      // refusal: reschedule_slot_taken
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    // The target time has no free agent in the bucket (#484): a legitimately
    // full slot, not a crash. 409 like the other unavailable cases so the caller
    // can offer another time instead of seeing a generic error.
    if (err instanceof NoEligibleAgentsError) {
      recordApiOutcome("error", "", "reschedule_no_eligible_agents");
      // refusal: reschedule_no_eligible_agents
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    recordApiOutcome("error", "", "reschedule_internal");
    // refusal: reschedule_internal
    return internalErrorResponse(err, "bookings/[token]/reschedule");
  }
}
