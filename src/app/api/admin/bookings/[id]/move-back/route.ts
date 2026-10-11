import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { currentUser, requireBookingActor } from "@/lib/auth";
import { forbiddenResponse } from "@/lib/auth/http";
import { adminMoveBackDemotionReroute } from "@/lib/booking/service";
import { mapReassignError } from "@/lib/booking/reassign-http";
import { crossOriginRefusal } from "@/lib/api/same-origin";

export const dynamic = "force-dynamic";

const schema = z.object({
  // The manager's second confirm, to put the call back on an advisor already at their daily cap.
  overrideCap: z.boolean().optional(),
});

/**
 * Move a rerouted call back to the advisor a demotion sweep moved it off (#3615).
 *
 * WHO: a manager or admin (`requireBookingActor`, the same gate as reassign), recorded as the
 * actor of the move and of the undo. WHOSE DATA: the caller's own org; the booking and the move
 * are both read scoped to it, so another org's booking answers 404.
 *
 * Answers: 200 `moved-back` or `already-recorded` (a second press is done, not a failure), 409
 * with the refusal's `reason` (the page says it, naming the people it is about), 404 for a
 * booking it cannot find, and a reassign refusal exactly as the reassign route answers it,
 * including the distinct over cap 409 that drives the two-step confirm.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const crossOrigin = crossOriginRefusal(req, "admin/bookings/[id]/move-back");
  if (crossOrigin) return crossOrigin;

  let actor: Awaited<ReturnType<typeof requireBookingActor>>;
  try {
    actor = await requireBookingActor();
  } catch (err) {
    return forbiddenResponse(err);
  }
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "Not authorized" }, { status: 403 });

  const { id } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  try {
    const out = await adminMoveBackDemotionReroute(id, me.org_id, actor, parsed.data.overrideCap ?? false);
    switch (out.kind) {
      case "moved-back":
        return NextResponse.json({ outcome: "moved-back", toUserId: out.toUserId });
      case "already-recorded":
        return NextResponse.json({ outcome: "already-recorded" });
      case "refused":
        return NextResponse.json({ error: "This call cannot be moved back.", reason: out.reason }, { status: 409 });
      case "not-found":
        return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }
  } catch (err) {
    return mapReassignError(err, "admin/bookings/[id]/move-back");
  }
}
