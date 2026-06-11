import { NextResponse, type NextRequest } from "next/server";
import { getBucketSlots } from "@/lib/availability/service";
import { allowRequest, clientIp, AVAILABILITY_RATE_RULES } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const DEFAULT_RANGE_DAYS = 14;

/**
 * GET /api/availability?bucket=411&from=ISO&to=ISO
 * Reads precomputed slots from the cache — no live Google calls.
 */
export async function GET(req: NextRequest) {
  // Throttle before any DB work (#56); fails open like the bookings limiter.
  if (!(await allowRequest(clientIp(req.headers), AVAILABILITY_RATE_RULES))) {
    return NextResponse.json(
      { error: "Too many requests. Please try again in a moment." },
      { status: 429 },
    );
  }

  const params = req.nextUrl.searchParams;
  const code = params.get("bucket");
  if (!code) {
    return NextResponse.json({ error: "Missing bucket" }, { status: 400 });
  }

  const now = Date.now();
  const from = params.get("from") ?? new Date(now).toISOString();
  const to =
    params.get("to") ??
    new Date(now + DEFAULT_RANGE_DAYS * 86_400_000).toISOString();

  const result = await getBucketSlots(code, from, to);
  if (!result) {
    return NextResponse.json({ error: "Unknown bucket" }, { status: 404 });
  }

  return NextResponse.json({
    bucket: { code: result.bucket.code, name: result.bucket.name },
    orgName: result.orgName,
    eventType: {
      name: result.eventType.name,
      description: result.eventType.description,
      durationMin: result.eventType.duration_min,
    },
    slots: result.slots,
  });
}
