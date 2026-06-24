import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { acquireLock, releaseLock } from "@/lib/locks";
import { mapWithConcurrency } from "@/lib/google/sync-pace";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { eligibleAgentIds } from "@/lib/availability/service";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  anyOnShift,
  failingBuckets,
  formatEmptyAvailabilityAlert,
  type BucketHealth,
  type WorkingRule,
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
// One consolidated alert (not one per bucket) so a broad outage is a single
// Slack message, not a storm — the cooldown throttles repeats.
const EMPTY_AVAIL_ALERT_KEY = "empty_availability";

/** Default zone for an agent with no schedule row, matching how the availability
 *  compute treats a scheduleless agent (America/New_York, no working rules). */
const DEFAULT_ZONE = "America/New_York";

/**
 * Availability-health probe (#371). DB-only: for every bucket with an eligible
 * agent ON SHIFT now whose cached slot set is freshly computed yet empty, fire a
 * throttled Slack alert. Catches "agents working but the booker shows no times"
 * (wedged sync, broken schedules, empty cache) — distinct from #327 (zero
 * eligible agents) and the recompute lane's staleness alarm. The on-shift gate is
 * per agent, in the agent's own timezone, so a bucket that is legitimately closed
 * (nobody working) stays silent and non-Eastern shifts are honored.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const now = Date.now();

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

    // Per-agent working hours, for the on-shift gate. Two reads joined in JS.
    const schedules = ((await db
      .from("availability_schedules")
      .select("id, user_id, timezone")).data ?? []) as {
      id: string;
      user_id: string;
      timezone: string;
    }[];
    const ruleRows = ((await db
      .from("availability_rules")
      .select("schedule_id, weekday, start_minute, end_minute")).data ?? []) as {
      schedule_id: string;
      weekday: number;
      start_minute: number;
      end_minute: number;
    }[];
    const scheduleByUser = new Map(schedules.map((s) => [s.user_id, { id: s.id, timezone: s.timezone }]));
    const rulesBySchedule = new Map<string, WorkingRule[]>();
    for (const r of ruleRows) {
      const list = rulesBySchedule.get(r.schedule_id) ?? [];
      list.push({ weekday: r.weekday, start_minute: r.start_minute, end_minute: r.end_minute });
      rulesBySchedule.set(r.schedule_id, list);
    }
    const shiftFor = (userId: string) => {
      const s = scheduleByUser.get(userId);
      return {
        timezone: s?.timezone ?? DEFAULT_ZONE,
        rules: s ? rulesBySchedule.get(s.id) ?? [] : [],
      };
    };

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
          onShiftNow: anyOnShift(now, ids.map(shiftFor)),
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
      `monitor: ${failing.length}/${buckets.length} bucket(s) on-shift-but-empty` +
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
