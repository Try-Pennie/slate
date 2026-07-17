import { NextResponse, type NextRequest } from "next/server";
import { requireManager } from "@/lib/auth";
import { forbiddenResponse } from "@/lib/auth/http";
import { searchBookings } from "@/lib/booking/search";
import { internalErrorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

/**
 * Booking lookup for the history viewer (#901): find bookings by attendee
 * email/name/phone or booking id. Manager+ gated (matches the other admin
 * booking routes) and tenant-scoped via the caller's org. A read fault surfaces
 * as 500, never an empty 200.
 */
export async function GET(req: NextRequest) {
  let me: Awaited<ReturnType<typeof requireManager>>;
  try {
    me = await requireManager();
  } catch (err) {
    return forbiddenResponse(err);
  }
  const q = req.nextUrl.searchParams.get("q") ?? "";
  try {
    const { rows, truncated } = await searchBookings(me.org_id, q);
    return NextResponse.json({ bookings: rows, truncated });
  } catch (err) {
    return internalErrorResponse(err, "admin/bookings/search");
  }
}
