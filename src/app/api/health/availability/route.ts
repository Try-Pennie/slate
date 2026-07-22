import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { loadTierDepths } from "@/lib/routing/staffing-depth-load";
import { listBucketSlotCounts } from "@/lib/availability/precompute";
import { computeAvailabilityCanary } from "@/lib/monitor/availability-canary";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Availability canary (#749). Unauthenticated and side-effect free, safe to expose
 * to an external uptime monitor (noodge). Returns 200 when the booker is genuinely
 * offering times and 503 when a well-staffed tier, or the whole fleet, is silently
 * empty, which /api/health cannot detect (the DB is up and the crons tick while the
 * booker offers nothing). Cheap: reads per-bucket present-agent depth (loadTierDepths)
 * plus the 4-day slot cache (bucket_slots), no live availability compute. The
 * PTO-aware decision lives in computeAvailabilityCanary.
 *
 * Pair it with /api/health in the monitor: this one trusts the cache's freshness,
 * and a stalled recompute lane (stale cache) is what /api/health catches instead.
 */
export async function GET() {
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
    log.error("availability-canary", { msg: "check failed" }, err);
    return NextResponse.json({ status: "degraded", reason: "check_error" }, { status: 503 });
  }
}
