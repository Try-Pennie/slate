import { NextResponse, type NextRequest } from "next/server";
import { getBucketSlotsWithFallback } from "@/lib/availability/slot-cache";
import { filterSlotsFromNow } from "@/lib/availability/compute";
import { availabilityWithinLimit, clientIp } from "@/lib/rate-limit";
import { parseApiKeys, authenticateBearer } from "@/lib/booking/api-auth";
import { bookingApiKeyPrimary, bookingApiKeySecondary } from "@/lib/env";

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

  // A synthetic test bucket (#396) is invisible to the public: only the
  // key-authed smoke test may read its slots. Resolve auth up front (DB-free:
  // parse the bearer against env keys) and gate the test bucket BEFORE the tier
  // cascade, so an unauthorized hidden bucket 404s doing the same single resolve
  // an unknown code does (no timing signal that it exists, #601).
  const keys = parseApiKeys(bookingApiKeyPrimary(), bookingApiKeySecondary());
  const authorizedForTest = authenticateBearer(
    req.headers.get("authorization"),
    keys,
  ).ok;

  const result = await getBucketSlotsWithFallback(code, from, authorizedForTest);
  if (!result) {
    // Unknown code and an unauthorized hidden test bucket both land here with
    // the identical response.
    return NextResponse.json({ error: "Unknown bucket" }, { status: 404 });
  }

  let slots = filterSlotsFromNow(result.slots, now, result.eventType.min_notice_min);
  if (toParam) {
    const toMs = Date.parse(to);
    slots = slots.filter((s) => Date.parse(s) <= toMs);
  }

  // Rule #259: leads must never see routing internals, even in the network
  // payload. Tier-drop is intentionally invisible: we report the REQUESTED
  // bucket code (what the lead asked for) and serve the EFFECTIVE tier's slots,
  // but the `routing` meta stays server-side only — never sent to the client.
  return NextResponse.json({
    bucket: { code: result.routing.requested_code },
    orgName: result.orgName,
    eventType: {
      name: result.eventType.name,
      description: result.eventType.description,
      durationMin: result.eventType.duration_min,
    },
    slots,
  });
}
