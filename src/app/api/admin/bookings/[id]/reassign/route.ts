import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireBookingActor } from "@/lib/auth";
import { forbiddenResponse } from "@/lib/auth/http";
import { adminReassignBooking } from "@/lib/booking/service";
import { validateReason } from "@/lib/booking/core";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { mapReassignError } from "@/lib/booking/reassign-http";
import { crossOriginRefusal } from "@/lib/api/same-origin";

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
  // #1046: this route's only credential is the session cookie, so refuse a request
  // that says it came from somewhere else, before the auth check and before the body
  // is read. See src/lib/api/same-origin.ts for why silence is allowed through.
  const crossOrigin = crossOriginRefusal(req, "admin/bookings/[id]/reassign");
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
    reasonOptions.reassign.selectable,
  );
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
    // Same typed contract as the machine reassign route (#717): at-cap -> a
    // DISTINCT 409 the UI uses for the two-step "Reassign anyway"; not-found ->
    // 404; a terminal (cancelled/completed) booking -> 409; anything else ->
    // generic 500 that never leaks internals (#598).
    return mapReassignError(err, "admin/bookings/[id]/reassign");
  }
}
