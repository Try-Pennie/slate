import { NextResponse, type NextRequest } from "next/server";
import { requireManager } from "@/lib/auth";
import { forbiddenResponse } from "@/lib/auth/http";
import { listBookingHistory } from "@/lib/booking/history";
import { internalErrorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

/**
 * A booking's reschedule/cancel/reassign history for the admin viewer (#561).
 * Manager+ gated (matches /api/admin/agents); tenant-scoped by passing the
 * caller's org, so listBookingHistory returns null (-> 404) for a booking the
 * caller can't see. A read fault surfaces as 500, never an empty 200.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let me: Awaited<ReturnType<typeof requireManager>>;
  try {
    me = await requireManager();
  } catch (err) {
    return forbiddenResponse(err);
  }
  const { id } = await params;
  try {
    const events = await listBookingHistory(id, me.org_id);
    if (events === null) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }
    return NextResponse.json({ events });
  } catch (err) {
    return internalErrorResponse(err, "admin/bookings/[id]/history");
  }
}
