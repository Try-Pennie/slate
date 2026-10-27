import { NextResponse } from "next/server";
import {
  DailyCapExceededError,
  BookingNotFoundError,
  AgentNotAvailableError,
  BookingNotChangeableError,
  ReassignAcrossWorldsError,
} from "@/lib/booking/service";
import { internalErrorResponse, reportInternalError } from "@/lib/api/errors";
import { AgentHeldError } from "@/lib/booking/reroute";
// From its own module rather than through the service, like AgentHeldError above,
// so the route tests that mock the service still throw the class this checks.
import {
  AttendeeEmailRefusedError,
  ATTENDEE_EMAIL_REFUSED_STAFF_ANSWER,
} from "@/lib/booking/attendee-email-refused";
import { StaffPlacedReassignRefusedError } from "@/lib/booking/staff-placed-refused";
import {
  OWNER_REFUSAL_CODE,
  OWNER_REFUSAL_STATUS,
  OwnerReassignRefusedError,
  OwnerReassignUnavailableError,
} from "@/lib/booking/owner-reassign-guard";

/**
 * Shared typed-error contract for BOTH reassign routes: the machine caller
 * (POST /api/bookings/reassign, #621) and the manager UI (POST
 * /api/admin/bookings/[id]/reassign, #717). One mapper so both classify a
 * reassign failure identically instead of drifting.
 *
 * The classification callers rely on: a 409 is a GENUINE conflict (stop
 * retrying), a 404 is bad input (stop), and a 5xx is transient (retry).
 * Substring routing used to send every non-'not found' failure (a terminal
 * booking, a Google/DB outage) back as the wrong status, so the contact-owner
 * automation would stop retrying a transiently-failed reassign and the manager
 * UI would surface a terminal booking as a generic 500.
 *
 * Anything unrecognized is an unexpected fault: a generic 500 that never leaks
 * internal detail (#598), not a 409.
 */
export async function mapReassignError(
  err: unknown,
  context: string,
): Promise<NextResponse> {
  // At-cap target: a distinct, recoverable 409 with a machine-readable code the
  // manager UI detects to drive the two-step "Reassign anyway" override (#546).
  if (err instanceof DailyCapExceededError) {
    return NextResponse.json(
      { error: err.message, code: "DAILY_CAP_EXCEEDED", agentEmail: err.agentEmail, day: err.day },
      { status: 409 },
    );
  }
  // The MACHINE contact-owner path refused the move (#2370): the booking is exactly
  // where it was and a person has been handed the decision. Only that path can raise
  // these two (the admin and bulk routes never run the owner guard), but they are
  // mapped here so both reassign routes keep ONE error contract.
  //
  // The status follows this file's own classification: `owner-not-found` is bad
  // input (404, as today), the other two are a genuine conflict (409) since the
  // request was valid and retrying it changes nothing until somebody acts. `handoff`
  // tells the caller whether this call opened the record or found it already open,
  // so a retry reads as the same refusal rather than a new one.
  if (err instanceof OwnerReassignRefusedError) {
    return NextResponse.json(
      {
        error: err.message,
        code: OWNER_REFUSAL_CODE[err.refusal],
        refusal: err.refusal,
        handoff: err.handoff,
      },
      { status: OWNER_REFUSAL_STATUS[err.refusal] },
    );
  }
  // A step of that check could not be completed, so NOTHING was decided: a read that
  // failed must never be reported as a refusal, and a refusal that could not be
  // recorded must never be reported as handed over. 503 so the caller retries, and
  // loud (log plus alert) because a failing read here is a real fault, not a
  // business outcome. `stage` is a fixed word of ours, never the underlying error.
  if (err instanceof OwnerReassignUnavailableError) {
    await reportInternalError(err, `${context}:owner-check`);
    return NextResponse.json(
      {
        error: "Slate could not check the requested owner. Please try again.",
        code: "OWNER_CHECK_UNAVAILABLE",
        stage: err.stage,
      },
      { status: 503 },
    );
  }
  // The target advisor is held for another booking's bucket correction (#3249). It
  // ends by itself within minutes, so it is TRANSIENT here: a 503 with Retry-After
  // set to the time left, which the machine reassign caller sharing this mapper
  // retries, never the 409 that tells it to stop. Its own code and sentence say
  // when it ends, so a manager waits or picks somebody else.
  if (err instanceof AgentHeldError) {
    const untilMs = err.heldUntilIso ? Date.parse(err.heldUntilIso) : NaN;
    const retryAfter = Number.isFinite(untilMs) ? Math.max(1, Math.ceil((untilMs - Date.now()) / 1000)) : 60;
    return NextResponse.json(
      { error: err.message, code: "HELD", heldUntil: err.heldUntilIso },
      { status: 503, headers: { "Retry-After": String(retryAfter) } },
    );
  }
  // Google refused to invite the lead's stored address (#3373), so the target's
  // invite was never written and the booking was left as it was. A 4xx because no
  // retry can succeed, with its own code so a machine caller can tell it from a
  // conflict, and the staff sentence, since the lead's "Enter a valid email
  // address" names a field nobody here has.
  if (err instanceof AttendeeEmailRefusedError) {
    return NextResponse.json(ATTENDEE_EMAIL_REFUSED_STAFF_ANSWER.body, {
      status: ATTENDEE_EMAIL_REFUSED_STAFF_ANSWER.status,
    });
  }
  // Genuine not-found (bad/stale booking id or target agent): do not retry.
  if (err instanceof BookingNotFoundError || err instanceof AgentNotAvailableError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  // Booking is (or became) terminal (cancelled/completed): a real conflict, not
  // a transient fault (#717).
  if (err instanceof BookingNotChangeableError) {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }
  // A move across worlds (#2660): a test booking onto a real agent or the
  // reverse. A genuine conflict (retrying changes nothing), with its own code so
  // a caller can tell it from a terminal booking.
  if (err instanceof ReassignAcrossWorldsError) {
    return NextResponse.json({ error: err.message, code: "ACROSS_WORLDS" }, { status: 409 });
  }
  // #4202: the owner automation met a call placed on the placeholder, which Regal
  // hands on itself. A genuine conflict, with its own code so the automation stops.
  if (err instanceof StaffPlacedReassignRefusedError) {
    return NextResponse.json({ error: err.message, code: "STAFF_PLACED" }, { status: 409 });
  }
  return internalErrorResponse(err, context);
}
