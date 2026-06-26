import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { acquireLock, releaseLock } from "@/lib/locks";
import { mapWithConcurrency } from "@/lib/google/sync-pace";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { eligibleAgentIdsCached } from "@/lib/availability/eligible-cache";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  anyOnShift,
  failingBuckets,
  formatEmptyAvailabilityAlert,
  type BucketHealth,
  type WorkingRule,
} from "@/lib/monitor/availability-health";
import {
  isBusinessHours,
  lowVolumeBreaches,
  formatLowVolumeAlert,
  type BusinessHoursConfig,
  type VolumeWindow,
} from "@/lib/monitor/booking-volume";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
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

// --- Low booking volume (#370) ---
// Eastern weekday daytime: outside these hours low volume is normal, so the
// volume alarm stays silent (the availability probe above still runs 24/7).
const VOLUME_BUSINESS_HOURS: BusinessHoursConfig = {
  zone: DEFAULT_ZONE,
  weekdays: [1, 2, 3, 4, 5],
  startHour: 8,
  endHour: 20,
};
// Expected-minimum booking counts per window, env-tunable. Defaults are
// conservative placeholders; tune them when ARMING at cutover. During the
// cal.com to Slate ramp the alert is DISARMED, so these don't fire yet.
const VOLUME_FLOOR_30 = Number(process.env.BOOKING_VOLUME_FLOOR_30 ?? "5");
const VOLUME_FLOOR_120 = Number(process.env.BOOKING_VOLUME_FLOOR_120 ?? "20");
// Disarmed by default: count and log, but never alert, until Slate owns roughly
// full traffic. Set BOOKING_VOLUME_ALERT_ARMED=1 at cutover to enable alerting.
const volumeAlertArmed = (): boolean => process.env.BOOKING_VOLUME_ALERT_ARMED === "1";
const VOLUME_ALERT_KEY = "low_booking_volume";
const VOLUME_ALERT_COOLDOWN_MS = 30 * 60_000;

/** Count bookings created at or after `sinceIso` (head-only, no rows). */
async function bookingsCreatedSince(
  db: ReturnType<typeof supabaseAdmin>,
  sinceIso: string,
): Promise<number> {
  const { count } = await db
    .from("bookings")
    .select("*", { count: "exact", head: true })
    .gte("created_at", sinceIso);
  return count ?? 0;
}

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
        const { ids } = await eligibleAgentIdsCached(bucket);
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

    // --- Low booking volume (#370): only during business hours; disarmed until
    // cutover (counts + logs but does not alert) so the ramp can't cry wolf. ---
    let volume: { armed: boolean; windows: VolumeWindow[]; breaches: number } | null = null;
    if (isBusinessHours(now, VOLUME_BUSINESS_HOURS)) {
      const [count30, count120] = await Promise.all([
        bookingsCreatedSince(db, new Date(now - 30 * 60_000).toISOString()),
        bookingsCreatedSince(db, new Date(now - 120 * 60_000).toISOString()),
      ]);
      const windows: VolumeWindow[] = [
        { label: "30 min", count: count30, floor: VOLUME_FLOOR_30 },
        { label: "120 min", count: count120, floor: VOLUME_FLOOR_120 },
      ];
      const breaches = lowVolumeBreaches(windows);
      const armed = volumeAlertArmed();
      if (breaches.length && armed) {
        await sendThrottledAlert(
          VOLUME_ALERT_KEY,
          VOLUME_ALERT_COOLDOWN_MS,
          formatLowVolumeAlert(breaches),
        ).catch(() => {});
      }
      console.log(
        `monitor volume: 30m=${count30} 120m=${count120}, ${breaches.length} below floor, armed=${armed}`,
      );
      volume = { armed, windows, breaches: breaches.length };
    }

    // Stamp the dead-man's switch (#420): proves this lane ran this tick.
    // Best-effort — must never affect the monitor's own response.
    await recordHeartbeat("monitor").catch(() => {});

    return NextResponse.json({
      buckets: buckets.length,
      failing: failing.length,
      codes: failing,
      truncated,
      volume,
    });
  } finally {
    await releaseLock("cron_monitor", lock);
  }
}
