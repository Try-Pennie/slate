import { NextResponse, type NextRequest } from "next/server";
import { requireManager } from "@/lib/auth";
import { forbiddenResponse } from "@/lib/auth/http";
import { internalErrorResponse } from "@/lib/api/errors";
import { bookingRescheduleTimesLive } from "@/lib/booking/reschedule-times-live";

export const dynamic = "force-dynamic";

/**
 * The times an advisor link booking may be moved to, for the admin move (#2827).
 *
 * The same compute the lead's manage page reads through
 * `/api/availability?booking=`, keyed here on the booking id so no lead
 * credential is ever put in a staff page. Manager+ gated like the move itself,
 * and read inside the caller's own org, so a booking elsewhere is refused exactly
 * like one that does not exist. A routed booking is refused too: its admin move
 * reads the bucket's pool, as it always has.
 *
 * A GET carrying no body, so no same origin check: it changes nothing, and the
 * session cookie is what authorises it.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let me: Awaited<ReturnType<typeof requireManager>>;
  try {
    me = await requireManager();
  } catch (err) {
    return forbiddenResponse(err);
  }
  const { id } = await params;
  try {
    const sp = req.nextUrl.searchParams;
    const reply = await bookingRescheduleTimesLive(
      { bookingId: id, orgId: me.org_id },
      { from: sp.get("from"), to: sp.get("to") },
      Date.now(),
    );
    return NextResponse.json(reply.body, { status: reply.status });
  } catch (err) {
    return internalErrorResponse(err, "admin/bookings/[id]/availability");
  }
}
