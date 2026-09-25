import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { loadTierDepths } from "@/lib/routing/staffing-depth-load";
import { listBucketSlotCounts } from "@/lib/availability/precompute";
import { computeAvailabilityCanary } from "@/lib/monitor/availability-canary";
import { log } from "@/lib/log";
import { stampUptimeHeartbeat } from "@/lib/monitor/uptime-heartbeat";

export const dynamic = "force-dynamic";

/**
 * Availability canary (#749). Unauthenticated and, apart from the heartbeat stamp
 * below, read only: safe to expose to an external uptime monitor (noodge). Returns 200 when the booker is genuinely
 * offering times and 503 when a well-staffed tier, or the whole fleet, is silently
 * empty, which /api/health cannot detect (the DB is up and the crons tick while the
 * booker offers nothing). Cheap: reads per-bucket present-agent depth (loadTierDepths)
 * plus the 4-day slot cache (bucket_slots), no live availability compute. The
 * PTO-aware decision lives in computeAvailabilityCanary.
 *
 * Pair it with /api/health in the monitor: this one trusts the cache's freshness,
 * and a stalled recompute lane (stale cache) is what /api/health catches instead.
 *
 * #1228: the one side effect. A request carrying the uptime heartbeat key (noodge's
 * check) stamps `uptime:availability-canary`, whatever the verdict, so a check
 * that stops firing goes stale and pages. The key never changes the answer, and
 * the stamp sits outside the verdict's try so a canary read failure cannot skip it.
 */
export async function GET(req: Request) {
  const stamped = stampUptimeHeartbeat(req.headers.get("authorization"), "uptime:availability-canary");
  const res = await verdictResponse();
  await stamped;
  return res;
}

async function verdictResponse(): Promise<NextResponse> {
  try {
    const db = supabaseAdmin();
    const [depths, slotRows] = await Promise.all([loadTierDepths(db), listBucketSlotCounts()]);
    const slotCountByCode = new Map(slotRows.map((r) => [r.code, r.slots]));
    const verdict = computeAvailabilityCanary(
      depths.map((d) => ({ code: d.code, effectiveDepth: d.effectiveDepth })),
      slotCountByCode,
    );
    if (!verdict.healthy) {
      log.warn("availability-canary", {
        msg: "degraded",
        reason: verdict.reason,
        broken: verdict.brokenBuckets.length,
        staffed: verdict.staffedCount,
      });
    }
    return NextResponse.json(
      {
        status: verdict.healthy ? "ok" : "degraded",
        reason: verdict.reason,
        staffedBuckets: verdict.staffedCount,
        brokenBuckets: verdict.brokenBuckets,
        unknownBuckets: verdict.unknownCount,
      },
      { status: verdict.httpStatus },
    );
  } catch (err) {
    // Fail loud: a read error must read as broken, never as a healthy 200.
    //
    // #1629: `loadTierDepths` used to answer an unreadable roster with an EMPTY
    // depth list, which never reached this catch at all. It reached the healthy
    // branch instead, with `staffedBuckets: 0`, and the external uptime monitor
    // read a 200 off a query that never ran. It throws now, so the failure lands
    // here.
    //
    // The counts are stated as `null`, not omitted and not zero. A count nobody
    // could measure is not a measurement of zero (the `slotHealthByCode`
    // precedent), and an absent field reads to a JSON consumer as "no buckets
    // reported" just as a zero does. `brokenBuckets` is the one exception: an
    // empty LIST here means "nothing is named", which is the truth, since naming
    // a broken bucket requires a reading that was never taken.
    log.error("availability-canary", { msg: "check failed" }, err);
    return NextResponse.json(
      {
        status: "degraded",
        reason: "check_error",
        staffedBuckets: null,
        brokenBuckets: [],
        unknownBuckets: null,
      },
      { status: 503 },
    );
  }
}
