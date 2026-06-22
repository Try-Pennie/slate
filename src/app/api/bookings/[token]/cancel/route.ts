import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { cancelBooking } from "@/lib/booking/service";
import { validateReason } from "@/lib/booking/core";

export const dynamic = "force-dynamic";

const schema = z.object({
  reason: z.string().optional(),
  reasonDetail: z.string().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Reason is mandatory (#326) — server-enforced, not just in the UI.
  const reason = validateReason("cancel", {
    code: parsed.data.reason,
    detail: parsed.data.reasonDetail,
  });
  if (!reason.ok) {
    return NextResponse.json({ error: reason.error }, { status: 400 });
  }

  try {
    await cancelBooking(token, reason.reason, "customer");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Cancel failed" },
      { status: 500 },
    );
  }
}
