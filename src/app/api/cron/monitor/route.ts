import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { acquireLock, releaseLock } from "@/lib/locks";
import { mapWithConcurrency } from "@/lib/google/sync-pace";
import { sendThrottledAlert, sendThrottledInfo } from "@/lib/notify/dispatch";
import { eligibleAgentIdsCached } from "@/lib/availability/eligible-cache";
import { getBucketSlots } from "@/lib/availability/service";
import { slotCacheKey } from "@/lib/availability/cache-key";
import { HORIZON_DAYS } from "@/lib/availability/slot-cache";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { tierLadder } from "@/lib/routing/tiers";
import { bucketSpecForXbc } from "@/lib/xbc";
import {
  anyOnShift,
  classifyEmptyBuckets,
  classifyDeadEndCause,
  formatDataAnomalyAlert,
  formatBookedSolidNotice,
  formatFallbackCoveredNotice,
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
import { alertOnStaleLanes } from "@/lib/monitor/lane-watchdog";
import { loadMonitorSettings } from "@/lib/monitor/settings";
import { loadTierDepths } from "@/lib/routing/staffing-depth-load";
import { runThinTierStaffingCheck } from "@/lib/monitor/thin-tier";
import type { Bucket } from "@/lib/db/types";
import { log } from "@/lib/log";

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
// Urgent page: a dead-end whose cache disagrees with the real calendars (or could
// not be verified). One consolidated message so a broad outage is one Slack post,
// not a storm; the cooldown throttles repeats. Cooldowns are UI-tunable (#571) via
// loadMonitorSettings(); these keys stay in code (they are alert_state row keys).
const DATA_ANOMALY_ALERT_KEY = "availability_data_anomaly";
// Quiet info: a dead-end because agents are booked solid. Full calendars are a
// good outcome, not an incident, so this whispers on a long cooldown.
const BOOKED_SOLID_INFO_KEY = "availability_booked_solid";
// Low-priority info signal (#567): empty tiers the fallback is quietly covering.
const FALLBACK_COVERED_INFO_KEY = "fallback_covered_availability";

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
// Expected-minimum booking counts per window are UI-tunable (#571), resolved by
// loadMonitorSettings() with precedence store > env (BOOKING_VOLUME_FLOOR_*) >
// coded default. Disarmed by default: count and log, but never alert, until Slate
// owns roughly full traffic. Set BOOKING_VOLUME_ALERT_ARMED=1 at cutover to enable
// alerting (arming stays deploy-gated, a cutover decision, not a routine tune).
const volumeAlertArmed = (): boolean => process.env.BOOKING_VOLUME_ALERT_ARMED === "1";
const VOLUME_ALERT_KEY = "low_booking_volume";

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
    // UI-tunable cooldowns + low-volume floors (#571); never throws (falls back
    // to env/coded defaults) so config can't take down the monitor tick.
    const settings = await loadMonitorSettings();
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
    // slot count + is_test per code, so the classifier can walk the tier ladder
    // (skipping synthetic test buckets, like the booker's fallback) with no extra IO.
    const bucketInfo = new Map(
      buckets.map((b) => [
        b.code,
        { slotCount: slotByCode.get(b.code)?.slotCount ?? 0, isTest: b.is_test ?? false },
      ]),
    );
    // Split empty-but-should-show buckets by whether the tier-drop fallback still
    // serves a customer (#567): only a true dead-end (whole ladder dry) pages; a
    // fallback-covered tier is a low-priority info signal, not an outage.
    const { page, covered } = classifyEmptyBuckets(health, {
      nowMs: now,
      freshWindowMs: FRESH_WINDOW_MS,
      ladder: tierLadder,
      bucketInfo,
    });
    // For each paged bucket (the rare all-ladder-dry dead-end), recompute
    // availability live from the DB (busy_blocks/bookings/schedules, no Google) and
    // compare to the cached zero: recompute 0 = booked solid; > 0 = the cache
    // disagrees with the calendars (data anomaly); a failed recompute = unverified.
    const recomputeCounts = new Map<string, number | null>();
    if (page.length) {
      const { results: recomputes } = await mapWithConcurrency<string, { code: string; count: number | null }>(
        page,
        PROBE_CONCURRENCY,
        async (code) => {
          const { fromIso, toIso } = slotCacheKey(code, new Date(now).toISOString(), HORIZON_DAYS);
          try {
            const res = await getBucketSlots(code, fromIso, toIso);
            return { code, count: res ? res.slots.length : null };
          } catch {
            return { code, count: null };
          }
        },
        { deadlineMs: now + MONITOR_LOCK_TTL_MS },
      );
      for (const r of recomputes) if (r) recomputeCounts.set(r.code, r.count);
    }
    const cause = classifyDeadEndCause(page, recomputeCounts);
    if (cause.dataAnomaly.length || cause.unverified.length) {
      await sendThrottledAlert(
        DATA_ANOMALY_ALERT_KEY,
        settings.cooldownMs.availability_data_anomaly,
        formatDataAnomalyAlert(cause),
      ).catch(() => {});
    }
    if (cause.bookedSolid.length) {
      await sendThrottledInfo(
        BOOKED_SOLID_INFO_KEY,
        settings.cooldownMs.availability_booked_solid,
        formatBookedSolidNotice(cause.bookedSolid),
      ).catch(() => {});
    }
    if (covered.length) {
      // Enrich each covered tier with its human name and the eligible-agent
      // depth of both tiers (#585), so the on-call notice needs no code lookup.
      // Counts come from the health scan already loaded; a code missing from it
      // (budget-truncated scan) leaves the depth null and the notice omits it.
      const eligibleByCode = new Map(health.map((h) => [h.code, h.eligibleCount]));
      const nameOf = (code: string) => bucketSpecForXbc(code)?.name ?? code;
      const coveredDetail = covered.map((c) => ({
        ...c,
        tierName: nameOf(c.code),
        viaTierName: nameOf(c.via),
        emptyDepth: eligibleByCode.get(c.code) ?? null,
        coverDepth: eligibleByCode.get(c.via) ?? null,
      }));
      await sendThrottledInfo(
        FALLBACK_COVERED_INFO_KEY,
        settings.cooldownMs.fallback_covered_availability,
        formatFallbackCoveredNotice(coveredDetail),
      ).catch(() => {});
    }
    log.info("monitor", {
      msg: "availability scan",
      dead_end: page.length,
      anomaly: cause.dataAnomaly.length,
      booked_solid: cause.bookedSolid.length,
      unverified: cause.unverified.length,
      fallback_covered: covered.length,
      buckets: buckets.length,
      page: page.length ? page.join(",") : null,
      covered: covered.length ? covered.map((c) => `${c.code}->${c.via}`).join(",") : null,
      truncated,
    });

    // --- Low booking volume (#370): only during business hours; disarmed until
    // cutover (counts + logs but does not alert) so the ramp can't cry wolf. ---
    let volume: { armed: boolean; windows: VolumeWindow[]; breaches: number } | null = null;
    if (isBusinessHours(now, VOLUME_BUSINESS_HOURS)) {
      const [count30, count120] = await Promise.all([
        bookingsCreatedSince(db, new Date(now - 30 * 60_000).toISOString()),
        bookingsCreatedSince(db, new Date(now - 120 * 60_000).toISOString()),
      ]);
      const windows: VolumeWindow[] = [
        { label: "30 min", count: count30, floor: settings.floors.floor30 },
        { label: "120 min", count: count120, floor: settings.floors.floor120 },
      ];
      const breaches = lowVolumeBreaches(windows);
      const armed = volumeAlertArmed();
      if (breaches.length && armed) {
        await sendThrottledAlert(
          VOLUME_ALERT_KEY,
          settings.cooldownMs.low_booking_volume,
          formatLowVolumeAlert(breaches),
        ).catch(() => {});
      }
      log.info("monitor", {
        msg: "booking volume",
        count_30m: count30,
        count_120m: count120,
        below_floor: breaches.length,
        armed,
      });
      volume = { armed, windows, breaches: breaches.length };
    }

    // --- Thin-tier staffing early warning (#569): a slow, low-priority whisper
    // of tiers resting on 1-2 bookable agents, reusing the #584 depth helper
    // (fallback-blind, so a configured fallback can't mask a thin tier), so
    // staffing can add coverage before a thin tier saturates and trips the
    // reactive availability signals above. depth-0 dead-ends are those signals'
    // job and are excluded; the info-channel post self-throttles to ~daily. ---
    const thinTierCount = await runThinTierStaffingCheck({
      loadDepths: () => loadTierDepths(db, undefined, new Date(now)),
      notify: sendThrottledInfo,
      cooldownMs: settings.cooldownMs.thin_tier_staffing,
      log: (m) => log.info("thin-tier", { msg: m }),
    });

    // Watch the other lanes (#803). The sync lane does this too; running it from
    // BOTH means the every-minute lanes and the 5-minute lanes watch each other,
    // so whichever survives a killed invocation reports the one that didn't. The
    // per-lane alert cooldown dedupes the overlap. Never throws.
    await alertOnStaleLanes();

    // Stamp the dead-man's switch (#420): proves this lane ran this tick.
    // Best-effort — must never affect the monitor's own response.
    await recordHeartbeat("monitor").catch(() => {});

    return NextResponse.json({
      buckets: buckets.length,
      failing: page.length,
      codes: page,
      fallbackCovered: covered,
      thinTiers: thinTierCount,
      truncated,
      volume,
    });
  } finally {
    await releaseLock("cron_monitor", lock);
  }
}
