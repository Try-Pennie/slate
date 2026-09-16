import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  rescheduleBooking,
  SlotUnavailableError,
  RescheduleConflictError,
  VerifyUnavailableError,
  RescheduleLockUnavailableError,
  NoEligibleAgentsError,
  ContactRefusedError,
} from "@/lib/booking/service";
import { validateReason } from "@/lib/booking/core";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { recordApiOutcome } from "@/lib/monitor/record-api-outcome";
import { internalErrorResponse } from "@/lib/api/errors";
import { INPUT_LIMITS } from "@/lib/booking/input-limits";
import { manageWithinLimit } from "@/lib/rate-limit";
// From the pure core rather than the re-export, so a test can stub the limiter without
// also having to hand back a working clientIp.
import { clientIp } from "@/lib/rate-limit-core";

export const dynamic = "force-dynamic";

const schema = z.object({
  // A parseable ISO instant (the booker sends slot starts as UTC `...Z` strings).
  // Reject garbage here so it can't reach bookingWindow's `new Date().toISOString()`,
  // which throws a RangeError on invalid input and surfaces as a generic 500 (#622).
  start: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Invalid start"),
  reason: z.string().optional(),
  reasonDetail: z.string().optional(),
  /**
   * The lead's own details, when they typed them on the way here (#2164).
   *
   * The booker's move panel is only reached by filling the form, and a lead's
   * commonest reason to come back is that the details they gave first were wrong.
   * Optional because every other caller of this endpoint (the emailed manage
   * link's own reschedule) has nobody typing anything.
   *
   * The shape check here is only a ceiling: a multi-MB blob is refused before it
   * reaches Postgres or a Google event body (#1034). Whether these are details we
   * can actually use is decided by the shared attendee rule inside the service, so
   * this route can never become a second, laxer opinion about an email address.
   */
  attendee: z
    .object({
      name: z.string().max(INPUT_LIMITS.contact).optional(),
      email: z.string().max(INPUT_LIMITS.contact).optional(),
      phone: z.string().max(INPUT_LIMITS.contact).optional(),
    })
    .optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  // #1046: bound what an unauthenticated caller costs us. Guessing a manage token is
  // infeasible, so this is not about getting in; it is about a garbage token buying a
  // database round trip per request with nothing counting them. Fails OPEN, so a
  // limiter hiccup can never stop a real customer moving their appointment.
  if (!(await manageWithinLimit(clientIp(req.headers)))) {
    // refusal: reschedule_rate_limited
    return NextResponse.json(
      { error: "Too many requests. Please try again in a moment." },
      { status: 429 },
    );
  }

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
    reasonOptions.reschedule.selectable,
  );
  if (!reason.ok) {
    // refusal: reschedule_invalid_reason
    return NextResponse.json({ error: reason.error }, { status: 400 });
  }

  try {
    const { booking, manageUrl, contactChanged } = await rescheduleBooking(
      token,
      parsed.data.start,
      reason.reason,
      "customer",
      parsed.data.attendee,
    );
    // A lead moving their own call is a booking ATTEMPT, and its refusals below are
    // counted (#1318). The success has to be counted with them or the share stops being
    // a share: adding only the failures would inflate the very number #1313 pages on.
    // Not bucket scoped, because reaching the code here would cost a lookup the manage
    // page has no other reason to do, and the tally coalesces a missing bucket to "".
    //
    // That empty bucket code is exactly why the test marker cannot be inferred from it
    // (#1616): this route is where the smoke canary's deliberate reschedule_conflict is
    // recorded, so a bucket-code filter would leave the canary's errors in the failure
    // rate and take its successes out. The marker travels as the TOKEN instead and is
    // resolved from the booking's own bucket, after the response.
    recordApiOutcome("rescheduled", "", null, { by: "manageToken", token });
    return NextResponse.json({
      id: booking.id,
      startsAt: booking.starts_at,
      endsAt: booking.ends_at,
      manageUrl,
      // #2164: what else this move changed, so the screen can say it. Omitted
      // entirely when nothing moved, rather than sent as three falses, because the
      // caller's question is "was there anything to tell them".
      ...(contactChanged ? { contactChanged } : {}),
    });
  } catch (err) {
    // #2164: the details they typed were refused, and nothing moved. A 400 with
    // the sentence about the value itself, because that is what the reader has to
    // act on; the time they picked is still there and still theirs to take.
    if (err instanceof ContactRefusedError) {
      recordApiOutcome("error", "", "reschedule_contact_refused", { by: "manageToken", token });
      // refusal: reschedule_contact_refused
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    // Outage (couldn't verify), not a full slot — retryable (#319).
    if (err instanceof VerifyUnavailableError) {
      recordApiOutcome("error", "", "reschedule_verify_unavailable", { by: "manageToken", token });
      // refusal: reschedule_verify_unavailable
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    // Fail-closed lock claim on a transient DB error (#479): safe to retry, so a
    // 503 like a verify outage, not a hard 500.
    if (err instanceof RescheduleLockUnavailableError) {
      recordApiOutcome("error", "", "reschedule_lock_unavailable", { by: "manageToken", token });
      // refusal: reschedule_lock_unavailable
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    // A concurrent reschedule moved this booking under us (#439). 409 like a slot
    // conflict; the distinct message tells the actor to refresh.
    // Every 409 names its reason (#1549). Three of them share this status and the
    // lead-facing surfaces answer two of them one way and one the other: a time that
    // went gets the soonest times still open beneath it, a booking that moved under
    // the reader must not, because the page is showing a time that is no longer the
    // booking's. Branching on the message would make the copy load-bearing (L35), so
    // the reason travels as its own field. `rescheduleOffersAlternatives` is the only
    // judge of it; these ids are the refusal-catalog ids already recorded above.
    if (err instanceof RescheduleConflictError) {
      recordApiOutcome("error", "", "reschedule_conflict", { by: "manageToken", token });
      // refusal: reschedule_conflict
      return NextResponse.json(
        { error: err.message, reason: "reschedule_conflict" },
        { status: 409 },
      );
    }
    if (err instanceof SlotUnavailableError) {
      recordApiOutcome("error", "", "reschedule_slot_taken", { by: "manageToken", token });
      // refusal: reschedule_slot_taken
      return NextResponse.json(
        { error: err.message, reason: "reschedule_slot_taken" },
        { status: 409 },
      );
    }
    // The target time has no free agent in the bucket (#484): a legitimately
    // full slot, not a crash. 409 like the other unavailable cases so the caller
    // can offer another time instead of seeing a generic error.
    if (err instanceof NoEligibleAgentsError) {
      recordApiOutcome("error", "", "reschedule_no_eligible_agents", { by: "manageToken", token });
      // refusal: reschedule_no_eligible_agents
      return NextResponse.json(
        { error: err.message, reason: "reschedule_no_eligible_agents" },
        { status: 409 },
      );
    }
    recordApiOutcome("error", "", "reschedule_internal", { by: "manageToken", token });
    // refusal: reschedule_internal
    return internalErrorResponse(err, "bookings/[token]/reschedule");
  }
}
