import { NextResponse, type NextRequest } from "next/server";
import { reassignApiKey } from "@/lib/env";
import { bearerTokenMatches } from "@/lib/bearer-auth";
import {
  reassignBooking,
  DailyCapExceededError,
  BookingNotFoundError,
  AgentNotAvailableError,
  BookingNotChangeableError,
} from "@/lib/booking/service";
import { internalErrorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

/**
 * Agent-reassign API (#9). An upstream automation that owns the
 * contact-stickiness decision calls this to force a booking onto a specific
 * owning advisor — even if that advisor is busy (the one place double-booking
 * is allowed). Bearer-authed with REASSIGN_API_KEY since it mutates and moves
 * calendar events.
 *
 *   POST { bookingId, agentEmail } -> 200 { booking, overCap } | 404 | 409 | 401/503
 */
export async function POST(req: NextRequest) {
  const key = reassignApiKey();
  if (!key) {
    return NextResponse.json({ error: "reassign api not configured" }, { status: 503 });
  }
  if (!bearerTokenMatches(req.headers.get("authorization"), key)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    bookingId?: string;
    agentEmail?: string;
    reasonCode?: string;
    reasonDetail?: string;
  };
  const bookingId = String(body.bookingId ?? "").trim();
  const agentEmail = String(body.agentEmail ?? "").trim();
  if (!bookingId || !agentEmail) {
    return NextResponse.json({ error: "bookingId and agentEmail are required" }, { status: 400 });
  }

  // Machine-to-machine path: the reason isn't picked from the customer lists, so
  // it's built directly (default = the contact-owner override) and recorded as a
  // 'reassigned' history event (#326), not validated against the picker options.
  const reasonCode = String(body.reasonCode ?? "").trim() || "owner_reassignment";
  const reasonDetail = String(body.reasonDetail ?? "").trim().slice(0, 500) || null;

  try {
    const result = await reassignBooking(
      bookingId,
      agentEmail,
      { code: reasonCode, detail: reasonDetail },
      true,
    );
    if (result.overCap) {
      console.warn(
        `reassign forced agent ${result.booking.agent_email} over their daily cap (booking ${result.booking.id})`,
      );
    }
    return NextResponse.json({
      booking: {
        id: result.booking.id,
        assignedUserId: result.booking.assigned_user_id,
        agentEmail: result.booking.agent_email,
        startsAt: result.booking.starts_at,
        status: result.booking.status,
      },
      overCap: result.overCap,
    });
  } catch (err) {
    return mapReassignError(err);
  }
}

/**
 * Typed error contract for the machine reassign caller (#621), mirroring the
 * direct booking API's mapBookingError. The classification the automation relies
 * on: a 409 is a GENUINE conflict (stop retrying), a 404 is bad input (stop),
 * and a 5xx is transient (retry). Substring routing used to send every
 * non-'not found' failure (including a Google/DB outage) back as a 409, so the
 * contact-owner automation would stop retrying a transiently-failed reassign.
 *
 * Anything unrecognized is an unexpected fault: a generic 500 that never leaks
 * internal detail (#598), not a 409.
 */
function mapReassignError(err: unknown): NextResponse {
  // At-cap target: a distinct, recoverable 409 with a machine-readable code (the
  // machine path passes overrideCap=true so this is rare, but the contract holds).
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
  // Booking is (or became) terminal: a real conflict, not a transient fault.
  if (err instanceof BookingNotChangeableError) {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }
  return internalErrorResponse(err, "bookings/reassign");
}
