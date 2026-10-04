import { NextResponse, type NextRequest } from "next/server";
import { requireBookingActor } from "@/lib/auth";
import { forbiddenResponse } from "@/lib/auth/http";
import { adminReleaseReroute } from "@/lib/booking/service";
import { mapRerouteError } from "@/lib/booking/reroute-http";
import { crossOriginRefusal } from "@/lib/api/same-origin";

export const dynamic = "force-dynamic";

/** Release a booking's held advisor (#3249): Cancel, or the admin walking away. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const crossOrigin = crossOriginRefusal(req, "admin/bookings/[id]/reroute/hold");
  if (crossOrigin) return crossOrigin;
  let actor: Awaited<ReturnType<typeof requireBookingActor>>;
  try {
    actor = await requireBookingActor();
  } catch (err) {
    return forbiddenResponse(err);
  }
  const { id } = await params;
  try {
    return NextResponse.json(await adminReleaseReroute(id, actor));
  } catch (err) {
    return mapRerouteError(err, "admin/bookings/[id]/reroute/hold");
  }
}
