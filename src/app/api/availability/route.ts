import { NextResponse, type NextRequest } from "next/server";
import { getCachedBucketSlots } from "@/lib/availability/slot-cache";
import { filterSlotsFromNow } from "@/lib/availability/compute";
import { availabilityWithinLimit, clientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const DEFAULT_RANGE_DAYS = 4;

/**
 * GET /api/availability?bucket=411&from=ISO&to=ISO
 * Reads precomputed slots from the cache — no live Google calls.
 */
export async function GET(req: NextRequest) {
  // Edge-throttle (#56) — in-datacenter, no DB round-trip, so the cached hot
  // path stays fast. Fails open.
  if (!(await availabilityWithinLimit(clientIp(req.headers)))) {
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
  const toParam = params.get("to");
  const to =
    toParam ?? new Date(now + DEFAULT_RANGE_DAYS * 86_400_000).toISOString();

  const result = await getCachedBucketSlots(code, from);
  if (!result) {
    return NextResponse.json({ error: "Unknown bucket" }, { status: 404 });
  }

  let slots = filterSlotsFromNow(result.slots, now, result.eventType.min_notice_min);
  if (toParam) {
    const toMs = Date.parse(to);
    slots = slots.filter((s) => Date.parse(s) <= toMs);
  }

  return NextResponse.json({
    bucket: { code: result.bucket.code, name: result.bucket.name },
    orgName: result.orgName,
    eventType: {
      name: result.eventType.name,
      description: result.eventType.description,
      durationMin: result.eventType.duration_min,
    },
    slots,
  });
}
