import { NextResponse, type NextRequest } from "next/server";

import { getBucketSlots } from "@/lib/availability/service";
import { filterSlotsFromNow } from "@/lib/availability/compute";
import { searchWindowDays } from "@/lib/availability/bookable-days";
import {
  probeWindows,
  findNextAvailableSlots,
} from "@/lib/availability/next-available";
import { loadBusinessHoursCached } from "@/lib/booking/business-hours-load";
import { loadBookingHorizonDays } from "@/lib/booking/settings";
import { availabilityWithinLimit, clientIp } from "@/lib/rate-limit";
import { internalErrorResponse } from "@/lib/api/errors";
import { isPublicTestBucket } from "@/lib/embed/public-test-bucket";
import { DateTime } from "luxon";

export const dynamic = "force-dynamic";

/**
 * GET /api/availability/next?bucket=411
 *
 * The first bookable days on the far side of a closure (#1329, #1339).
 *
 * The ordinary availability search is bounded for cost (#1326), so during a long
 * closure it honestly returns nothing and a lead is left with no idea when to come
 * back. This runs the longer search, and it runs ONLY for a lead who pressed the
 * button, so the cost is paid by the few who arrive during a shutdown rather than
 * by every bucket on every recompute pass.
 *
 * Deliberately NOT cached, in either direction:
 *
 *  - it does not read the slot cache, because the days it is looking for lie
 *    outside the horizon window every cached row is keyed on;
 *  - it does not WRITE the cache, because a row holding out-of-horizon days would
 *    be read back by the ordinary path and offered as though it were inside the
 *    horizon, which is #1264's whole concern in reverse.
 *
 * It is rate limited on the same edge window as `/api/availability`, since it is
 * strictly more expensive per call and sits behind a button anyone can press.
 */
export async function GET(req: NextRequest) {
  try {
    return await handle(req);
  } catch (err) {
    return internalErrorResponse(err, "availability-next");
  }
}

async function handle(req: NextRequest) {
  if (!(await availabilityWithinLimit(clientIp(req.headers)))) {
    return NextResponse.json(
      { error: "Too many requests. Please try again in a moment." },
      { status: 429 },
    );
  }

  const code = req.nextUrl.searchParams.get("bucket");
  if (!code) return NextResponse.json({ error: "Missing bucket" }, { status: 400 });

  const [hours, horizonDays] = await Promise.all([
    loadBusinessHoursCached(),
    loadBookingHorizonDays(),
  ]);
  const nowMs = Date.now();
  // Start the walk where the ordinary search gave up, so no ground is computed
  // twice: `searchWindowDays` is the exact span the cached path already covered.
  const searchedThroughDay = DateTime.fromMillis(nowMs)
    .setZone(hours.zone)
    .plus({ days: searchWindowDays(horizonDays) - 1 })
    .toISODate();
  if (!searchedThroughDay) {
    return NextResponse.json({ error: "Unknown bucket" }, { status: 404 });
  }

  // A missing bucket is indistinguishable from a hidden test bucket here, matching
  // /api/availability: a real lead must never learn a hidden bucket exists (#396).
  let bucketExists = true;
  const slots = await findNextAvailableSlots({
    probes: probeWindows({ searchedThroughDay, zone: hours.zone }),
    wantDays: horizonDays,
    zone: hours.zone,
    compute: async (probe) => {
      const res = await getBucketSlots(code, probe.fromIso, probe.toIso);
      if (!res) {
        bucketExists = false;
        return [];
      }
      // A HIDDEN test bucket does not exist to this path, which is lead facing
      // only (the smoke test uses /api/availability). The PUBLIC test bucket
      // (#2660) does exist, so a tester arriving during a closure can look
      // further ahead like a lead can; the two are told apart by the code alone.
      if (res.bucket.is_test && !isPublicTestBucket(code)) {
        bucketExists = false;
        return [];
      }
      // Min notice still applies out here: a slot a lead cannot book is not a day.
      return filterSlotsFromNow(res.slots, nowMs, res.eventType.min_notice_min);
    },
  });

  if (!bucketExists) return NextResponse.json({ error: "Unknown bucket" }, { status: 404 });

  return NextResponse.json(
    { slots },
    // Never store: these days sit outside the horizon the ordinary path serves, so
    // a shared cache holding them could hand them to a reader that believes they
    // are inside it.
    { headers: { "cache-control": "no-store" } },
  );
}
