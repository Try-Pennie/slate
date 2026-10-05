import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireBookingActor } from "@/lib/auth";
import { forbiddenResponse } from "@/lib/auth/http";
import { adminConfirmReroute } from "@/lib/booking/service";
import { mapRerouteError, readRerouteBody } from "@/lib/booking/reroute-http";
import { crossOriginRefusal } from "@/lib/api/same-origin";

export const dynamic = "force-dynamic";

// A move names its hold; a keep names no hold and the bucket to correct to.
const schema = z.union([
  z.object({ holdId: z.string().uuid(), note: z.string().max(500).nullish() }),
  z.object({
    holdId: z.null(),
    bucketCode: z.string().min(1).max(16),
    // A keep in a lower tier: the bucket asked for and the drop, from the proposal.
    requestedBucketCode: z.string().min(1).max(16).nullish(),
    rungsDropped: z.number().int().min(0).max(5).optional(),
    note: z.string().max(500).nullish(),
  }),
]);

/** Confirm a reroute (#3249): turn the hold into the move, or correct only the bucket. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const crossOrigin = crossOriginRefusal(req, "admin/bookings/[id]/reroute/confirm");
  if (crossOrigin) return crossOrigin;
  let actor: Awaited<ReturnType<typeof requireBookingActor>>;
  try {
    actor = await requireBookingActor();
  } catch (err) {
    return forbiddenResponse(err);
  }
  const { id } = await params;
  const parsed = await readRerouteBody(req, schema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  try {
    const keep = "bucketCode" in body ? body : null;
    const outcome = await adminConfirmReroute(
      id,
      {
        holdId: body.holdId,
        bucketCode: keep?.bucketCode ?? null,
        requestedBucketCode: keep?.requestedBucketCode ?? null,
        rungsDropped: keep?.rungsDropped ?? 0,
        note: body.note ?? null,
      },
      actor,
    );
    return NextResponse.json(outcome);
  } catch (err) {
    return mapRerouteError(err, "admin/bookings/[id]/reroute/confirm");
  }
}
