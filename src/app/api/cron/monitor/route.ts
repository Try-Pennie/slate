import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { acquireLock, releaseLock } from "@/lib/locks";
import { mapWithConcurrency } from "@/lib/google/sync-pace";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { eligibleAgentIds } from "@/lib/availability/service";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  isWithinBusinessHours,
  failingBuckets,
  formatEmptyAvailabilityAlert,
  type BucketHealth,
  type BusinessHoursConfig,
} from "@/lib/monitor/availability-health";
import type { Bucket } from "@/lib/db/types";

export const dynamic = "force-dynamic";

// Own lock so the monitor lane can't be starved by, or starve, the other lanes
// sharing the every-5-min trigger. Short TTL: the probe is a quick DB-only scan.
const MONITOR_LOCK_TTL_MS = 2 * 60_000;
// Bound the per-bucket eligible-agent reads (matches the Cloudflare connection
// bound used by the other lanes); a hard deadline so a slow scan can't overrun.
const PROBE_CONCURRENCY = 6;
// A bucket_slots row only counts as a real (computed) empty within this window;
// a stale/missing row is the recompute lane's concern, not a booker fault.
const FRESH_WINDOW_MS = 6 * 60_000;
const EMPTY_ALERT_COOLDOWN_MS = 30 * 60_000;
// Eastern, weekdays, daytime: outside these hours an empty bucket is legitimate
// (no agent scheduled), so the probe stays silent rather than crying wolf.
const BUSINESS_HOURS: BusinessHoursConfig = {
  zone: "America/New_York",
  weekdays: [1, 2, 3, 4, 5],
  startHour: 8,
  endHour: 20,
};
// One consolidated alert (not one per bucket) so a broad outage is a single
// Slack message, not a storm — the cooldown throttles repeats.
const EMPTY_AVAIL_ALERT_KEY = "empty_availability";

/**
 * Availability-health probe (#371). DB-only: for every bucket with eligible
 * agents whose cached slot set is freshly computed yet empty, during business
 * hours, fire a throttled Slack alert. Catches "agents assigned but the booker
 * shows no times" (wedged sync, broken schedules, empty cache) — distinct from
 * #327 (zero eligible agents) and the recompute lane's staleness alarm.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const now = Date.now();
  if (!isWithinBusinessHours(now, BUSINESS_HOURS)) {
    return NextResponse.json({ skipped: "outside-business-hours" });
  }

  const lock = await acquireLock("cron_monitor", MONITOR_LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });

  try {
    const db = supabaseAdmin();
    const buckets = ((await db.from("buckets").select("*")).data ?? []) as Bucket[];

    // bucket_slots health in one scan: slot count + freshness per code.
    const slotRows = ((await db
      .from("bucket_slots")
      .select("bucket_code, payload, computed_at")).data ?? []) as {
      bucket_code: string;
      payload: { slots?: string[] } | null;
      computed_at: string;
    }[];
    const slotByCode = new Map(
      slotRows.map((r) => [
        r.bucket_code,
        { slotCount: r.payload?.slots?.length ?? 0, computedAtMs: Date.parse(r.computed_at) },
      ]),
    );

    const { results, truncated } = await mapWithConcurrency<Bucket, BucketHealth>(
      buckets,
      PROBE_CONCURRENCY,
      async (bucket) => {
        const slot = slotByCode.get(bucket.code);
        const { ids } = await eligibleAgentIds(bucket);
        return {
          code: bucket.code,
          eligibleCount: ids.length,
          slotCount: slot?.slotCount ?? 0,
          computedAtMs: slot?.computedAtMs ?? null,
        };
      },
      { deadlineMs: now + MONITOR_LOCK_TTL_MS },
    );

    const health = results.filter(Boolean) as BucketHealth[];
    const failing = failingBuckets(health, { nowMs: now, freshWindowMs: FRESH_WINDOW_MS });
    if (failing.length) {
      await sendThrottledAlert(
        EMPTY_AVAIL_ALERT_KEY,
        EMPTY_ALERT_COOLDOWN_MS,
        formatEmptyAvailabilityAlert(failing),
      ).catch(() => {});
    }
    console.log(
      `monitor: ${failing.length}/${buckets.length} bucket(s) eligible-but-empty` +
        (failing.length ? ` (${failing.join(", ")})` : "") +
        (truncated ? " [scan truncated by budget]" : ""),
    );

    return NextResponse.json({
      buckets: buckets.length,
      failing: failing.length,
      codes: failing,
      truncated,
    });
  } finally {
    await releaseLock("cron_monitor", lock);
  }
}
