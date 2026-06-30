import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireManager } from "@/lib/auth";
import {
  adminRescheduleBooking,
  SlotUnavailableError,
  RescheduleConflictError,
  VerifyUnavailableError,
  NoEligibleAgentsError,
} from "@/lib/booking/service";
import { validateReason } from "@/lib/booking/core";

export const dynamic = "force-dynamic";

const schema = z.object({
  start: z.string().min(1),
  reason: z.string().optional(),
  reasonDetail: z.string().optional(),
});

/** Admin reschedule by booking id (#326). Manager+ gated (#544); initiator='admin'. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireManager();
  const { id } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const reason = validateReason("reschedule", {
    code: parsed.data.reason,
    detail: parsed.data.reasonDetail,
  });
  if (!reason.ok) {
    return NextResponse.json({ error: reason.error }, { status: 400 });
  }

  try {
    const { booking } = await adminRescheduleBooking(id, parsed.data.start, reason.reason);
    return NextResponse.json({
      id: booking.id,
      startsAt: booking.starts_at,
      status: booking.status,
    });
  } catch (err) {
    if (err instanceof VerifyUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    // A concurrent reschedule moved this booking under us (#439): 409 + a distinct
    // refresh message.
    if (err instanceof RescheduleConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof SlotUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    // No free agent in the bucket at the target time (#484): a full slot, not a
    // crash. 409 like the other unavailable cases.
    if (err instanceof NoEligibleAgentsError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Reschedule failed" },
      { status: 500 },
    );
  }
}
