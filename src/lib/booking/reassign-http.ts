import { NextResponse } from "next/server";
import {
  DailyCapExceededError,
  BookingNotFoundError,
  AgentNotAvailableError,
  BookingNotChangeableError,
} from "@/lib/booking/service";
import { internalErrorResponse } from "@/lib/api/errors";

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
  // Genuine not-found (bad/stale booking id or target agent): do not retry.
  if (err instanceof BookingNotFoundError || err instanceof AgentNotAvailableError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  // Booking is (or became) terminal (cancelled/completed): a real conflict, not
  // a transient fault (#717).
  if (err instanceof BookingNotChangeableError) {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }
  return internalErrorResponse(err, context);
}
