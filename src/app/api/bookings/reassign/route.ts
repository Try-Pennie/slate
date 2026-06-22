import { NextResponse, type NextRequest } from "next/server";
import { reassignApiKey } from "@/lib/env";
import { reassignBooking } from "@/lib/booking/service";

export const dynamic = "force-dynamic";

/**
 * Agent-reassign API (#9). An upstream automation that owns the
 * contact-stickiness decision calls this to force a booking onto a specific
 * owning advisor — even if that advisor is busy (the one place double-booking
 * is allowed). Bearer-authed with REASSIGN_API_KEY since it mutates and moves
 * calendar events.
 *
 *   POST { bookingId, agentEmail } -> 200 { booking } | 404 | 409 | 401/503
 */
export async function POST(req: NextRequest) {
  const key = reassignApiKey();
  if (!key) {
    return NextResponse.json({ error: "reassign api not configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${key}`) {
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
    const result = await reassignBooking(bookingId, agentEmail, {
      code: reasonCode,
      detail: reasonDetail,
    });
    return NextResponse.json({
      booking: {
        id: result.booking.id,
        assignedUserId: result.booking.assigned_user_id,
        agentEmail: result.booking.agent_email,
        startsAt: result.booking.starts_at,
        status: result.booking.status,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("not found") ? 404 : 409;
    return NextResponse.json({ error: message }, { status });
  }
}
