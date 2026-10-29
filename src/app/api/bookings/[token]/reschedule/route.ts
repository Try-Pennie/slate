import { NextResponse, type NextRequest } from "next/server";
import { withinBookingCleanupBudget, withinBookingRequest } from "@/lib/booking/confirm-budget";
import { answerTimed, noteRefusal, type ConfirmLineFacts } from "@/lib/booking/confirm-latency";
import { timeStage } from "@/lib/booking/confirm-profile";
import { z } from "zod";
import {
  rescheduleBooking,
  pageBookingFailure,
  bookingDetailExtras,
  SlotUnavailableError,
  RescheduleConflictError,
  VerifyUnavailableError,
  RescheduleLockUnavailableError,
  NoEligibleAgentsError,
  ContactRefusedError,
  AttendeeEmailRefusedError,
  OutsideCallingWindowError,
  BookingNotChangeableError,
  BookingNotFoundError,
} from "@/lib/booking/service";
import { validateReason } from "@/lib/booking/core";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { isBookingWriteFailure } from "@/lib/booking/gated-write";
import { recordApiOutcome } from "@/lib/monitor/record-api-outcome";
import { internalErrorResponse, reportInternalError } from "@/lib/api/errors";
import { isTestManageTokenForPaging } from "@/lib/monitor/test-traffic";
import { noStore } from "@/lib/api/no-store";
import { partnerKeysFrom } from "@/lib/booking/partner-keys";
import { bookingIdentityFrom } from "@/lib/booking/booking-identity";
import { INPUT_LIMITS } from "@/lib/booking/input-limits";
import { timezoneSchema } from "@/lib/booking/input-schema";
import { BOOKING_ERROR_COPY } from "@/lib/booking/booker-copy";
import { manageWithinLimit } from "@/lib/rate-limit";
// From the pure core rather than the re-export, so a test can stub the limiter without
// also having to hand back a working clientIp.
import { clientIp } from "@/lib/rate-limit-core";
import { readJsonCapped, PUBLIC_JSON_MAX_BYTES } from "@/lib/http/read-json-capped";
import type { BookingContext } from "@/lib/booking/orchestration";
import { verifyProgramLeadToken } from "@/lib/booking/program-lead-gate";
import { isProgramLead } from "@/lib/booking/program-lead";
import { loadProgramLeadMoveContext, moveProgramLeadLive } from "@/lib/booking/program-lead-booking-service";
import { PLACEHOLDER_DAY_FULL_CODE, PlaceholderDayFullError } from "@/lib/booking/program-lead-booking";
import { PROGRAM_PLACEHOLDER_OUTCOME } from "@/lib/monitor/booking-api-outcome";
import { namesAdvisorToLead } from "@/lib/booking/advisor-name";

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
      // #2549: the answered first name, which travels with `name`.
      firstName: z.string().max(INPUT_LIMITS.contact).optional(),
      email: z.string().max(INPUT_LIMITS.contact).optional(),
      phone: z.string().max(INPUT_LIMITS.contact).optional(),
    })
    .optional(),
  /**
   * #2310: the zone the page showed the new time in, which is the lead's clock
   * the calling window is judged in. Optional, because a page cached from before
   * this shipped will not send it; then the zone the booking was MADE in is
   * judged instead, which is the lead's own and never a free pass. The same cap
   * as the booker's field, so a long value is refused before it is read.
   */
  timezone: timezoneSchema.optional(),
  /**
   * #4391: the token that lets a program lead move THIS call onto the placeholder's
   * extra times, minted for this booking by the manage page or the booker's landing.
   * Judged against the booking the manage token names; a value that is too long or not
   * a string is DROPPED, and the move is the ordinary one.
   */
  programLeadMoveToken: z.string().max(256).optional().catch(undefined),
});

/**
 * #4391: the booking this move may take onto the placeholder, or null for the ordinary
 * move. The exception to #4203 lives here and nowhere else: only this lead facing route
 * reads a move token, and only for a booking whose own mark says it is a program lead's
 * (`isProgramLead`), the token signed for that very booking and its Lead. Every other
 * caller of the shared reschedule (Marcia's MCP channel, admin moves, the direct API, the
 * coordinator) never reaches it. Reads nothing unless a token was presented.
 */
async function programLeadMove(token: string, presented: string | undefined): Promise<BookingContext | null> {
  if (presented === undefined) return null;
  const ctx = await loadProgramLeadMoveContext(token);
  if (!ctx?.booking.salesforce_id) return null;
  const facts = verifyProgramLeadToken(presented, { salesforceId: ctx.booking.salesforce_id, bookingId: ctx.booking.id });
  if (facts?.purpose !== "move") return null;
  return isProgramLead({ booking: ctx.booking, nowMs: Date.now() }) ? ctx : null;
}

/**
 * #2561: one wrapper rather than a header on each of the returns below. Every
 * ending of this handler, the moves and the refusals alike, describes one lead's
 * booking at one moment and carries the manage URL with it, and a return added
 * later carries the directive by construction instead of by somebody remembering
 * (L96).
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  // #3102: one budget for the whole request; see `confirm-budget.ts`. A deadline
  // from a read before the move's own try (the limiter, the reason options) is the
  // same outage the move answers with its retryable 503, rather than escaping as
  // an unhandled 500.
  //
  // #3401: the same `confirm answered` line a booking writes, saying it was a move,
  // so a time change's wait is measurable and a slow or timed out one carries the
  // stage profile (#3300).
  const facts: ConfirmLineFacts = {};
  return noStore(
    await answerTimed(
      "booking",
      () =>
        withinBookingRequest(
          () => handlePost(req, ctx, facts),
          async (timeout) => {
            noteRefusal(facts, timeout);
            return timeStage(facts.profile, "failure-path", async () => {
              const { token } = await ctx.params;
              await pageBookingFailure(timeout);
              recordApiOutcome("error", "", "reschedule_verify_unavailable", { by: "manageToken", token });
              // refusal: reschedule_verify_unavailable
              return NextResponse.json({ error: timeout.message }, { status: 503 });
            });
          },
          facts.profile?.observeCalls(),
        ),
      { facts, kind: "move" },
    ),
  );
}

async function handlePost(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
  facts: ConfirmLineFacts,
) {
  // #3300: everything before the move itself, as one stage.
  const endChecks = facts.profile?.begin("route-checks");
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
  // #3135: read under a byte cap rather than buffering whatever arrives.
  const read = await readJsonCapped(req, PUBLIC_JSON_MAX_BYTES);
  if (read.tooLarge) {
    // refusal: reschedule_body_too_large
    return NextResponse.json({ error: "Request too large" }, { status: 413 });
  }
  const parsed = schema.safeParse(read.value);
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

  const programCtx = await programLeadMove(token, parsed.data.programLeadMoveToken);

  endChecks?.();
  try {
    // #4391: a program lead's own move tries a real advisor first and then the
    // placeholder (`program-lead-booking.ts`); every other move, as before.
    const program = programCtx
      ? await moveProgramLeadLive({
          token,
          ctx: programCtx,
          startIso: parsed.data.start,
          reason: reason.reason,
          attendee: parsed.data.attendee,
          zone: parsed.data.timezone,
          lineFacts: facts,
        })
      : null;
    const { booking, manageUrl, contactChanged, isTest } = program
      ? program.result
      : await rescheduleBooking(
          token,
          parsed.data.start,
          reason.reason,
          "customer",
          parsed.data.attendee,
          parsed.data.timezone,
          // #3401: the line's facts, so the move charges its profile and names its lead.
          facts,
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
    //
    // #4391: a program lead's move onto the placeholder is counted under its own name,
    // outside the share, for the reason a new one is (`PROGRAM_PLACEHOLDER_OUTCOME`).
    recordApiOutcome(program?.onPlaceholder ? PROGRAM_PLACEHOLDER_OUTCOME.move : "rescheduled", "", null, { by: "manageToken", token });
    return NextResponse.json({
      id: booking.id,
      // #2750: the lead ids the moved call is STORED under, which stay the ones it
      // was first booked with. The page the lead moved it from can carry another
      // lead id (a second submission, recognised by the weak match, #1340), and
      // the host's confirmed page lookup refuses a booking that id does not own
      // (#2657), so the host must be handed the booking's own.
      ...bookingIdentityFrom(booking),
      startsAt: booking.starts_at,
      endsAt: booking.ends_at,
      manageUrl,
      // #2164: what else this move changed, so the screen can say it. Omitted
      // entirely when nothing moved, rather than sent as three falses, because the
      // caller's question is "was there anything to tell them".
      ...(contactChanged ? { contactChanged } : {}),
      // #2658: the booker announces the moved call to its host in the same shape
      // as a fresh booking (#2660 put the flag on the confirm response), so a
      // moved test call is never reported to the host as a real one. Read off the
      // booking's own bucket by the booking layer, never off the caller.
      isTest: isTest === true,
      // #2644: the add to calendar links at the NEW time, from the one builder,
      // so the moved call's success message to the host carries what a fresh
      // booking's does. The contact stays off it, as on the fresh one (#2643).
      calendarLinks: bookingDetailExtras(booking).calendarLinks,
      // #2165: who the moved call is now with, for the Booker's confirmation
      // after a move. A move can change the advisor, so it is read off the
      // booking the move returned rather than the panel's earlier copy. #4391: never the
      // placeholder advisor's name, who is nobody the lead will speak to.
      advisorName: namesAdvisorToLead(booking) ? (booking.agent_name ?? null) : null,
      // #2659: the partner join keys, off the booking that moved (its prefill
      // came from the page it was first booked on), so the host's success
      // message for a moved call carries what a fresh booking's does.
      ...partnerKeysFrom(booking.prefill),
    });
  } catch (err) {
    // #3300: a timeout, said on the line.
    noteRefusal(facts, err);
    // #3102: the failure path runs under the cleanup allowance, not the confirm
    // budget, which a timeout has already spent; its outcome and report would
    // otherwise fail at once and the failure would go unrecorded.
    return timeStage(facts.profile, "failure-path", () => withinBookingCleanupBudget(async () => {
      // #4391: a program lead moved onto an extra time on a day whose extra times are
      // all gone. The call did not move and nothing was invited (the claim comes first).
      // Its own reason, code and sentence, never the taken time one (L11); not one of the
      // reasons that offers alternatives, since the reloaded picker shows the day's real
      // times. Counted per day by #4392; logged under its own tag where it was refused.
      if (err instanceof PlaceholderDayFullError) {
        // refusal: reschedule_placeholder_day_full
        return NextResponse.json(
          { error: BOOKING_ERROR_COPY.placeholderDayFull, reason: "reschedule_placeholder_day_full", code: PLACEHOLDER_DAY_FULL_CODE },
          { status: 409 },
        );
      }
      // #2164: the details they typed were refused, and nothing moved. A 400 with
      // the sentence about the value itself, because that is what the reader has to
      // act on; the time they picked is still there and still theirs to take.
      if (err instanceof ContactRefusedError) {
        recordApiOutcome("error", "", "reschedule_contact_refused", { by: "manageToken", token });
        // refusal: reschedule_contact_refused
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      // #3373: Google refused to invite the address the booking already holds, so
      // the move's invite was never written and the call is where it was. Not
      // `reschedule_internal` and a page: it is about the lead's email, and a wave
      // of it means our address rule and Google's have drifted apart, which the
      // share names under its own code. Not a 409 either: no time was taken, so the
      // alternatives a 409 opens would offer times that fail the same way.
      if (err instanceof AttendeeEmailRefusedError) {
        recordApiOutcome("error", "", "reschedule_attendee_email_refused", { by: "manageToken", token });
        // refusal: reschedule_attendee_email_refused
        return NextResponse.json(
          { error: BOOKING_ERROR_COPY.moveEmailRefused, reason: "reschedule_attendee_email_refused" },
          { status: 422 },
        );
      }
      // #2310: the new time starts outside the lead's calling window. Not a 409:
      // nothing is taken and the booking did not move under them, so neither of
      // those answers (or the alternatives panel a 409 opens) would be true. The
      // page only offers times inside the window, so a wave of these means the
      // page and the rule disagree, which is why it is counted.
      if (err instanceof OutsideCallingWindowError) {
        recordApiOutcome("error", "", "reschedule_outside_calling_window", { by: "manageToken", token });
        // refusal: reschedule_outside_calling_window
        return NextResponse.json(
          { error: BOOKING_ERROR_COPY.outsideCallingHours, reason: "reschedule_outside_calling_window" },
          { status: 422 },
        );
      }
      // Outage (couldn't verify), not a full slot: retryable (#319).
      if (err instanceof VerifyUnavailableError) {
        recordApiOutcome("error", "", "reschedule_verify_unavailable", { by: "manageToken", token });
        // refusal: reschedule_verify_unavailable
        return NextResponse.json({ error: err.message }, { status: 503 });
      }
      // #2373: the gated commit did not RUN, so the call has not moved. Kept ABOVE
      // the conflict branch below because it used to be answered BY it: a refused
      // statement made `commitReschedule` report zero rows, which reads as a
      // concurrent change, so the lead was told to refresh and pick again by a write
      // that never happened. Refreshing repairs a lost race and does nothing at all
      // for this, so it gets its own retriable status and a sentence that says
      // nothing changed. Reported through the same chokepoint an unexpected fault
      // goes through, so somebody is paged rather than only counted.
      if (isBookingWriteFailure(err)) {
        recordApiOutcome("error", "", "reschedule_write_failed", { by: "manageToken", token });
        // #3580: the smoke canary reschedules its own test bookings here, so withhold
        // the page for test traffic (resolved server-side from the booking's bucket);
        // a real one still pages, and an unreadable marker pages.
        await reportInternalError(err, "bookings/[token]/reschedule", {
          page: !(await isTestManageTokenForPaging(token)),
        });
        // refusal: reschedule_write_failed
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
      // The booking is (or became) terminal (cancelled/completed): a lead acting on a
      // call that is over, not a crash (#3569). A real conflict like the reassign path
      // (#717), so 409 and the same message, counted in the share but never paging.
      // It names its reason like the other 409s (#1549), so a client tells "this call
      // is over" from "the booking moved under you" without branching on the copy
      // (L35). Not in RESCHEDULE_TIME_GONE_REASONS, so no alternative-times panel.
      if (err instanceof BookingNotChangeableError) {
        recordApiOutcome("error", "", "reschedule_terminal", { by: "manageToken", token });
        // refusal: reschedule_terminal
        return NextResponse.json(
          { error: err.message, reason: "reschedule_terminal" },
          { status: 409 },
        );
      }
      // The manage token resolves to no booking (#3569): a 404, not a 500 that pages.
      // Not counted, because the token is unguessable, so a miss is a hand-made request
      // whose volume would only dilute the failure share (same reasoning as the 429).
      if (err instanceof BookingNotFoundError) {
        // refusal: reschedule_not_found
        return NextResponse.json({ error: err.message }, { status: 404 });
      }
      recordApiOutcome("error", "", "reschedule_internal", { by: "manageToken", token });
      // refusal: reschedule_internal (#3580: test traffic is logged but does not page)
      return internalErrorResponse(err, "bookings/[token]/reschedule", {
        page: !(await isTestManageTokenForPaging(token)),
      });
    }));
  }
}
