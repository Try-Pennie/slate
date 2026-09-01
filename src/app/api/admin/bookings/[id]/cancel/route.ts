import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireBookingActor } from "@/lib/auth";
import { forbiddenResponse } from "@/lib/auth/http";
import { adminCancelBooking } from "@/lib/booking/service";
import { validateReason } from "@/lib/booking/core";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { internalErrorResponse } from "@/lib/api/errors";
import { crossOriginRefusal } from "@/lib/api/same-origin";

export const dynamic = "force-dynamic";

const schema = z.object({
  reason: z.string().optional(),
  reasonDetail: z.string().optional(),
});

/** Admin cancel by booking id (#326). Manager+ gated (#544); initiator='admin'. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // #1046: this route's only credential is the session cookie, so refuse a request
  // that says it came from somewhere else, before the auth check and before the body
  // is read. See src/lib/api/same-origin.ts for why silence is allowed through.
  const crossOrigin = crossOriginRefusal(req, "admin/bookings/[id]/cancel");
  if (crossOrigin) return crossOrigin;

  let actor: Awaited<ReturnType<typeof requireBookingActor>>;
  try {
    actor = await requireBookingActor();
  } catch (err) {
    return forbiddenResponse(err);
  }
  const { id } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const reasonOptions = await loadReasonOptions();
  const reason = validateReason(
    { code: parsed.data.reason, detail: parsed.data.reasonDetail },
    reasonOptions.cancel.all,
  );
  if (!reason.ok) {
    return NextResponse.json({ error: reason.error }, { status: 400 });
  }

  try {
    await adminCancelBooking(id, reason.reason, actor);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return internalErrorResponse(err, "admin/bookings/[id]/cancel");
  }
}
