import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireBookingActor } from "@/lib/auth";
import { adminReassignBooking, DailyCapExceededError } from "@/lib/booking/service";
import { validateReason } from "@/lib/booking/core";

export const dynamic = "force-dynamic";

const schema = z.object({
  agentEmail: z.string().min(1),
  reason: z.string().optional(),
  reasonDetail: z.string().optional(),
  // Set on the manager's second confirm to push through an at-cap target (#546).
  overrideCap: z.boolean().optional(),
});

/** Manager reassign by booking id (#546). Manager+ gated; initiator='admin' and
 *  the acting staff user is recorded (#549). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireBookingActor();
  const { id } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const reason = validateReason("reassign", {
    code: parsed.data.reason,
    detail: parsed.data.reasonDetail,
  });
  if (!reason.ok) {
    return NextResponse.json({ error: reason.error }, { status: 400 });
  }

  try {
    const { booking, overCap } = await adminReassignBooking(
      id,
      parsed.data.agentEmail,
      reason.reason,
      actor,
      parsed.data.overrideCap ?? false,
    );
    return NextResponse.json({
      id: booking.id,
      agentEmail: booking.agent_email,
      startsAt: booking.starts_at,
      status: booking.status,
      overCap,
    });
  } catch (err) {
    // Target is at their daily cap: a DISTINCT, recoverable 409 the client uses to
    // show the warning + offer the two-step "Reassign anyway" (re-POST overrideCap).
    if (err instanceof DailyCapExceededError) {
      return NextResponse.json(
        { error: err.message, code: "DAILY_CAP_EXCEEDED", agentEmail: err.agentEmail, day: err.day },
        { status: 409 },
      );
    }
    const message = err instanceof Error ? err.message : "Reassign failed";
    // "Booking not found" / "Agent not found or not bookable" are bad input (404/400);
    // anything else is unexpected (500).
    if (message.includes("not found")) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
