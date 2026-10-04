import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireBookingActor } from "@/lib/auth";
import { forbiddenResponse } from "@/lib/auth/http";
import { adminStartReroute, adminCurrentReroute } from "@/lib/booking/service";
import { mapRerouteError } from "@/lib/booking/reroute-http";
import { crossOriginRefusal } from "@/lib/api/same-origin";

export const dynamic = "force-dynamic";

const schema = z.object({ bucketCode: z.string().min(1).max(16) });

/**
 * Start a reroute (#3249): find who should take this booking in the corrected
 * bucket, at its existing time, and hold them when they are new. Manager and above,
 * the same gate and same origin check as the admin reassign route.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const crossOrigin = crossOriginRefusal(req, "admin/bookings/[id]/reroute");
  if (crossOrigin) return crossOrigin;
  let actor: Awaited<ReturnType<typeof requireBookingActor>>;
  try {
    actor = await requireBookingActor();
  } catch (err) {
    return forbiddenResponse(err);
  }
  const { id } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  try {
    return NextResponse.json(await adminStartReroute(id, parsed.data.bucketCode, actor));
  } catch (err) {
    return mapRerouteError(err, "admin/bookings/[id]/reroute");
  }
}

/** The booking's live hold, so a reload restores the confirm panel and its countdown. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let actor: Awaited<ReturnType<typeof requireBookingActor>>;
  try {
    actor = await requireBookingActor();
  } catch (err) {
    return forbiddenResponse(err);
  }
  const { id } = await params;
  try {
    return NextResponse.json({ proposal: await adminCurrentReroute(id, actor) });
  } catch (err) {
    return mapRerouteError(err, "admin/bookings/[id]/reroute:get");
  }
}
