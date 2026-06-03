import { NextResponse, type NextRequest } from "next/server";
import { cancelBooking } from "@/lib/booking/service";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  try {
    await cancelBooking(token);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Cancel failed" },
      { status: 500 },
    );
  }
}
