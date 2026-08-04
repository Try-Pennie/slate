import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { acquireLock, releaseLock } from "@/lib/locks";
import { sendThrottledAlert, sendThrottledInfo, resolveAlert } from "@/lib/notify/dispatch";
import { eligibleAgentIdsCached } from "@/lib/availability/eligible-cache";
import { getBucketSlots } from "@/lib/availability/service";
import { loadAllWorkingHours } from "@/lib/availability/working-hours-load";
import { slotCacheKey } from "@/lib/availability/cache-key";
import { recomputeBucketSlotsForToday } from "@/lib/availability/slot-cache";
import { loadBookingHorizonDays } from "@/lib/booking/settings";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { slotHealthByCode, type SlotHealthRow } from "@/lib/monitor/slot-health";
import { tierLadder } from "@/lib/routing/tiers";
import { bucketSpecForXbc } from "@/lib/xbc";
import { type WorkingRule } from "@/lib/monitor/availability-health";
import { runAvailabilityScan } from "@/lib/monitor/availability-scan";
import {
  runLowVolumeCheck,
  type BusinessHoursConfig,
  type LowVolumeResult,
} from "@/lib/monitor/booking-volume";
import { recordHeartbeat, readHeartbeatMs } from "@/lib/monitor/heartbeat";
import { alertOnStaleLanes } from "@/lib/monitor/lane-watchdog";
import {
  runCanaryGapFills,
  postCanaryWorkflowDispatch,
} from "@/lib/monitor/canary-trigger";
import { githubCanaryToken } from "@/lib/env";
import {
  runMigrationDriftCheck,
  readAppliedMigrationVersions,
} from "@/lib/monitor/migration-drift";
import { SHIPPED_MIGRATION_VERSION } from "@/lib/db/migration-version";
import { loadMonitorSettings } from "@/lib/monitor/settings";
import { loadTierDepths } from "@/lib/routing/staffing-depth-load";
import { runThinTierStaffingCheck } from "@/lib/monitor/thin-tier";
import {
  runCalcomOverrideSweep,
  type OverrideCandidate,
} from "@/lib/monitor/calcom-override-sweep";
import { addOooOverrides } from "@/lib/calcom/client";
import { EFFECTS } from "@/lib/ooo/orchestration";
import { ID_BATCH_ROWS } from "@/lib/db/id-batch";
import {
  missingScheduleAgents,
  runScheduleCoverageCheck,
  type ScheduleLessAgent,
} from "@/lib/monitor/schedule-coverage";
import {
  runAttributeCoverageCheck,
  findUnroutableAgents,
  type UnroutableAgent,
} from "@/lib/monitor/attribute-coverage";
import { ensureDefaultSchedules } from "@/lib/schedule";
import {
  runSyncStalenessCheck,
  syncRotationCandidates,
  type SyncAgentStaleness,
} from "@/lib/monitor/sync-staleness";
import {
  inactiveHoldersFromBookings,
  runInactiveAgentBookingsCheck,
  type OutOfPoolAgent,
} from "@/lib/monitor/inactive-agent-bookings";
import {
  runCoverageNeedsHumanCheck,
  strandedHoldersFromItems,
  type CoverageOutAgent,
  type StrandedAppointment,
  type StrandedStatus,
} from "@/lib/monitor/coverage-needs-human";
import { ACTIONABLE_ITEM_STATUSES } from "@/lib/booking/bulk-reassign";
import { unwrap } from "@/lib/db/result";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking/bulk-reassign-store";
import { selectAllPages } from "@/lib/supabase/paginate";
import type { Attributes, Bucket } from "@/lib/db/types";
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
// The urgent data-anomaly page (a dead-end whose cache disagrees with the real
// calendars, or could not be verified) and its all-clear now live together in
// availability-health.ts, which owns DATA_ANOMALY_ALERT_KEY. Cooldowns are
// UI-tunable (#571) via loadMonitorSettings(); the keys stay in code (they are
// alert_state row keys).
// #573: on a data anomaly the monitor rewrites the fresh row so the booker recovers
// at once, but only ONCE per bucket per this window (a DB lock we deliberately do
// NOT release), so a persistent fault keeps paging instead of being silently
// re-masked every minute.
const ANOMALY_SELFHEAL_WINDOW_MS = 15 * 60_000;

// #1167: a suspected anomaly is re-checked this many more times before it pages,
// so a momentary disagreement (a read landing mid-write) does not wake anyone.
// Two extra checks two seconds apart adds ~4s to a tick that found something, and
// nothing at all to the ordinary healthy tick. Kept well inside the 2-minute lock
// TTL, and the verifier stops at the scan deadline regardless.
const ANOMALY_VERIFY_ATTEMPTS = 2;
const ANOMALY_VERIFY_DELAY_MS = 2_000;
// Above this, skip re-verification and page now: a wide anomaly is an outage
// rather than a blip, and re-reading every bucket would spend a subrequest budget
// this lane shares with three others (complete, watch, bulk-reassign).
const ANOMALY_VERIFY_MAX_BUCKETS = 8;

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
// coded default. Arming is now UI-tunable too (#575): loadMonitorSettings resolves
// `lowVolumeArmed` with precedence store > env (BOOKING_VOLUME_ALERT_ARMED) >
// disarmed default, so the cutover flip no longer needs a redeploy.

/** Count bookings created at or after `sinceIso` (head-only, no rows), or null
 *  when the read failed: runLowVolumeCheck treats null as unverified rather
 *  than paging a false "0 bookings" off a query that never ran (#1158). */
async function bookingsCreatedSince(
  db: ReturnType<typeof supabaseAdmin>,
  sinceIso: string,
): Promise<number | null> {
  const { count, error } = await db
    .from("bookings")
    .select("*", { count: "exact", head: true })
    .gte("created_at", sinceIso);
  if (error) {
    log.error("monitor", { msg: "booking volume count read failed", since: sinceIso }, error);
    return null;
  }
  return count ?? 0;
}

/**
 * Approved absences whose cal.com override FAILED and whose absence has not ended
 * (#1253), or null when the read failed (which the sweep treats as unmeasured
 * rather than as nothing to do).
 *
 * Keyed on the recorded failure, not on `calcom_synced`: 631 approved requests
 * predate the dual-write and carry no cal.com outcome, so the flag alone selects
 * hundreds of rows whose absences are long past.
 */
async function loadFailedOverrideCandidates(
  db: ReturnType<typeof supabaseAdmin>,
): Promise<OverrideCandidate[] | null> {
  const { data, error } = await db
    .from("ooo_requests")
    .select("id, user_id, starts_at, ends_at, side_effects")
    .eq("status", "approved")
    .gt("ends_at", new Date().toISOString())
    .like("side_effects->>calcom", "failed%")
    .limit(ID_BATCH_ROWS);
  if (error) {
    log.error("calcom-sweep", { msg: "candidate read failed" }, error);
    return null;
  }
  const rows = (data ?? []) as {
    id: string;
    user_id: string;
    starts_at: string;
    ends_at: string;
    side_effects: Record<string, string> | null;
  }[];
  if (rows.length === 0) return [];

  // The agent's email, which is what the override is keyed on in cal.com and what
  // the alert has to name. A separate bounded read rather than an embed, matching
  // the two-reads-joined-in-code convention used elsewhere in this codebase.
  const { data: users, error: userErr } = await db
    .from("users")
    .select("id, email")
    .in("id", rows.map((r) => r.user_id));
  if (userErr) {
    log.error("calcom-sweep", { msg: "candidate email read failed" }, userErr);
    return null;
  }
  const emailById = new Map(
    ((users ?? []) as { id: string; email: string }[]).map((u) => [u.id, u.email]),
  );
  return rows.map((r) => ({
    id: r.id,
    email: emailById.get(r.user_id) ?? r.user_id,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    effect: r.side_effects?.[EFFECTS.calcom] ?? "",
  }));
}

/**
 * Re-attempt one request's cal.com override and record what happened, returning the
 * new outcome. Writing the outcome back is what makes the sweep self-clearing: an
 * "ok" or "skipped" no longer matches the failure predicate, so the row leaves the
 * candidate set without any extra bookkeeping.
 *
 * `calcom_synced` is set only on "ok", because it means "an override exists that a
 * cancellation must undo" and a skip wrote nothing.
 */
async function retryOverrideForRequest(
  db: ReturnType<typeof supabaseAdmin>,
  requestId: string,
): Promise<string> {
  const { data, error } = await db
    .from("ooo_requests")
    .select("id, user_id, starts_at, ends_at, side_effects")
    .eq("id", requestId)
    .maybeSingle();
  if (error || !data) return "failed: could not re-read the request";
  const row = data as {
    user_id: string;
    starts_at: string;
    ends_at: string;
    side_effects: Record<string, string> | null;
  };
  const { data: user } = await db
    .from("users")
    .select("email")
    .eq("id", row.user_id)
    .maybeSingle();
  const email = (user as { email?: string } | null)?.email;
  if (!email) return "failed: agent has no email";

  const outcome = await addOooOverrides(email, row.starts_at, row.ends_at);
  const { error: writeErr } = await db
    .from("ooo_requests")
    .update({
      side_effects: { ...(row.side_effects ?? {}), [EFFECTS.calcom]: outcome },
      ...(outcome === "ok" ? { calcom_synced: true } : {}),
    })
    .eq("id", requestId);
  if (writeErr) {
    // The override may well have landed; what failed is recording it. Say so,
    // rather than reporting the cal.com outcome as if it were persisted.
    log.error("calcom-sweep", { msg: "outcome write failed", request_id: requestId }, writeErr);
    return "failed: outcome not recorded";
  }
  return outcome;
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
    // #1169: fail closed. An unparseable computed_at reads as epoch 0 (stale,
    // canary alerts), never NaN (reads as fresh, canary silent). Extracted in
    // #1171 so that direction is pinned by scripts/test-monitor-slot-health.ts
    // instead of living untested inside the route.
    const slotByCode = slotHealthByCode(slotRows);

    // Per-agent working hours, for the on-shift gate. Two whole-table reads
    // joined in JS; both are paged past PostgREST's 1,000-row cap (#828): the
    // rules table alone crosses 1,000 at full roster, and a truncated read would
    // silently mis-judge who is on shift.
    const { schedules, rules: ruleRows } = await loadAllWorkingHours(db);
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

    // The scan orchestration (probe, classify, recompute-verify, self-heal, page /
    // whisper / all-clear) lives in runAvailabilityScan (#1158), tested directly in
    // scripts/test-monitor-availability-scan.ts. The route only wires the IO.
    // Probe the SAME window the rows are computed over (#216): comparing a 4-day
    // probe against a 7-day row would flag a false data anomaly. Loaded once and
    // reused by the self-heal.
    const horizonDays = await loadBookingHorizonDays();
    const bucketByCode = new Map(buckets.map((b) => [b.code, b]));
    const scan = await runAvailabilityScan({
      nowMs: now,
      freshWindowMs: FRESH_WINDOW_MS,
      probeConcurrency: PROBE_CONCURRENCY,
      deadlineMs: now + MONITOR_LOCK_TTL_MS,
      buckets: buckets.map((b) => ({ code: b.code, isTest: b.is_test ?? false })),
      slotByCode,
      ladder: tierLadder,
      nameOf: (code) => bucketSpecForXbc(code)?.name ?? code,
      eligibleIds: async (code) => {
        const bucket = bucketByCode.get(code);
        if (!bucket) return [];
        const { ids } = await eligibleAgentIdsCached(bucket);
        return ids;
      },
      shiftFor,
      // Live recompute from the DB (busy_blocks/bookings/schedules, no Google);
      // a falsy result or a throw is null (unverified), never a fake zero.
      recomputeSlots: async (code) => {
        const { fromIso, toIso } = slotCacheKey(code, new Date(now).toISOString(), horizonDays);
        const res = await getBucketSlots(code, fromIso, toIso);
        return res ? res.slots.length : null;
      },
      // #1167: re-check a suspected anomaly before paging. `cachedSlots` must be a
      // FRESH single-row read, not the slotByCode map above: that map is the side
      // of the comparison suspected of being wrong, so re-reading it would just
      // repeat the same answer. Routed through slotHealthByCode so an unreadable
      // computed_at fails the same way here as in the scan (#1171).
      verify: {
        attempts: ANOMALY_VERIFY_ATTEMPTS,
        delayMs: ANOMALY_VERIFY_DELAY_MS,
        maxBuckets: ANOMALY_VERIFY_MAX_BUCKETS,
        cachedSlots: async (code) => {
          // cap-safe: bucket_code is unique in bucket_slots, so this is one row.
          const { data, error } = await db
            .from("bucket_slots")
            .select("bucket_code, payload, computed_at")
            .eq("bucket_code", code)
            .maybeSingle();
          // A read we could not do must read as unknown, never as a healthy zero:
          // the verifier treats null as inconclusive and keeps the finding.
          if (error) return null;
          if (!data) return 0;
          return slotHealthByCode([data as SlotHealthRow]).get(code)?.slotCount ?? 0;
        },
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      claimHeal: async (code) =>
        (await acquireLock(`anomaly_selfheal:${code}`, ANOMALY_SELFHEAL_WINDOW_MS)) !== null,
      heal: (code) => recomputeBucketSlotsForToday(code, true, undefined, horizonDays),
      onHealError: (code, err) =>
        log.error("monitor", { msg: "anomaly self-heal failed", bucket: code }, err),
      notify: sendThrottledAlert,
      info: sendThrottledInfo,
      // all-clear-proof: scripts/test-monitor-availability-scan.ts - a truncated
      // scan sends no all-clear and a paging tick does not also all-clear.
      resolve: resolveAlert,
      cooldownMs: {
        dataAnomaly: settings.cooldownMs.availability_data_anomaly,
        bookedSolid: settings.cooldownMs.availability_booked_solid,
        fallbackCovered: settings.cooldownMs.fallback_covered_availability,
      },
      log: (fields) => log.info("monitor", { msg: "availability scan", ...fields }),
    });
    if (scan.cleared) log.info("monitor", { msg: "availability anomaly alert cleared" });
    const { page, covered, truncated } = scan;

    // --- Low booking volume (#370): only during business hours; disarmed until
    // cutover (counts + logs but does not alert) so the ramp can't cry wolf.
    // Extracted and tested (#1158): a failed count read reports unverified
    // rather than paging a false zero. ---
    const volume: LowVolumeResult = await runLowVolumeCheck({
      nowMs: now,
      businessHours: VOLUME_BUSINESS_HOURS,
      countSince: (sinceIso) => bookingsCreatedSince(db, sinceIso),
      floors: settings.floors,
      armed: settings.lowVolumeArmed,
      cooldownMs: settings.cooldownMs.low_booking_volume,
      notify: sendThrottledAlert,
      log: (fields) => log.info("monitor", { msg: "booking volume", ...fields }),
    });

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

    // --- Schedule coverage (#838): a bookable agent with no availability_schedules
    // row silently shows zero availability and takes no bookings. The row should
    // exist (ensureDefaultSchedules fills it on roster sync), so first try to
    // self-heal the benign case (a new agent between syncs), then whisper ONLY for
    // the ones the fill could not create. Both reads are paged past PostgREST's
    // 1,000-row cap; the schedule read is re-run after the heal so the recheck
    // sees what the fill actually created. ---
    const loadMissingAgents = async (): Promise<ScheduleLessAgent[]> => {
      const [agents, scheds] = await Promise.all([
        selectAllPages<ScheduleLessAgent>(
          "monitor schedule-coverage bookable agents",
          (from, to) =>
            db
              .from("users")
              .select("id, name, email, org_id")
              .eq("bookable", true)
              .is("deactivated_at", null)
              .eq("is_test", false)
              .range(from, to),
        ),
        selectAllPages<{ user_id: string }>(
          "monitor schedule-coverage schedules",
          (from, to) => db.from("availability_schedules").select("user_id").range(from, to),
        ),
      ]);
      return missingScheduleAgents(agents, new Set(scheds.map((s) => s.user_id)));
    };
    const scheduleCoverage = await runScheduleCoverageCheck({
      loadMissingAgents,
      heal: async (orgIds) => {
        // Per-org so one org's failed fill can't skip the others; a throw is
        // logged and left for the recheck to surface as the alert.
        for (const orgId of orgIds) {
          await ensureDefaultSchedules(orgId).catch(() =>
            log.warn("schedule-coverage", { msg: "self-heal fill failed", org_id: orgId }),
          );
        }
      },
      notify: sendThrottledInfo,
      cooldownMs: settings.cooldownMs.agents_without_schedule,
      log: (m) => log.info("schedule-coverage", { msg: m }),
    });

    // --- Routing-attribute coverage (#226): a bookable agent with no routing
    // attributes matches no bucket criteria, so unless someone added them as a
    // manual member they are never routed a booking. There is no self-heal
    // (attributes can't be invented), so this only whispers the list. Both reads
    // page past the 1,000-row cap. ---
    const loadUnroutableAgents = async (): Promise<UnroutableAgent[]> => {
      const [agents, members] = await Promise.all([
        selectAllPages<{
          id: string;
          name: string | null;
          email: string | null;
          attributes: Attributes | null;
        }>(
          "monitor attribute-coverage bookable agents",
          (from, to) =>
            db
              .from("users")
              .select("id, name, email, attributes")
              .eq("bookable", true)
              .is("deactivated_at", null)
              .eq("is_test", false)
              .range(from, to),
        ),
        selectAllPages<{ user_id: string }>(
          "monitor attribute-coverage manual members",
          (from, to) =>
            db.from("bucket_members").select("user_id").eq("active", true).range(from, to),
        ),
      ]);
      return findUnroutableAgents(agents, new Set(members.map((m) => m.user_id)));
    };
    const attributeCoverage = await runAttributeCoverageCheck({
      loadUnroutableAgents,
      notify: sendThrottledInfo,
      cooldownMs: settings.cooldownMs.agents_without_routing,
      log: (m) => log.info("attribute-coverage", { msg: m }),
    });

    // --- Sync-staleness gauge (#241): after #238 the backstop sync rotates
    // least-recently-synced first, so nothing surfaced an agent silently dropping
    // out of the rotation (roster too large for a tick, or a stuck agent). Load the
    // bookable agents that ARE in the rotation (a calendar row exists; a bookable
    // agent with none is the schedule/watch-onboarding lane's concern) and alert if
    // any is stale. markAgentsSynced stamps even errored agents, so a stale
    // last_synced_at means "not picked up", the residual gap the health probe /
    // heartbeat / anomaly checks don't cover. Both reads page past the 1,000 cap. ---
    const loadStaleCandidates = async (): Promise<SyncAgentStaleness[]> => {
      const [agents, cals] = await Promise.all([
        selectAllPages<{ id: string; name: string | null; email: string | null; last_synced_at: string | null }>(
          "monitor sync-staleness agents",
          (from, to) =>
            db
              .from("users")
              .select("id, name, email, last_synced_at")
              .eq("bookable", true)
              .is("deactivated_at", null)
              .eq("is_test", false)
              .range(from, to),
        ),
        selectAllPages<{ user_id: string }>(
          "monitor sync-staleness calendars",
          (from, to) => db.from("agent_calendars").select("user_id").range(from, to),
        ),
      ]);
      return syncRotationCandidates(agents, new Set(cals.map((c) => c.user_id)));
    };
    const syncStaleness = await runSyncStalenessCheck({
      loadAgents: loadStaleCandidates,
      nowMs: now,
      notify: sendThrottledAlert,
      cooldownMs: settings.cooldownMs.sync_staleness,
      log: (m) => log.info("sync-staleness", { msg: m }),
    });

    // --- Appointments held by an agent who has left the pool (#1215): a customer
    // booked with a departed advisor. Deactivating and reassigning are independent
    // actions, and the Salesforce roster sync deactivates with no admin present at
    // all, so this is the backstop for both paths. Two reads: the out-of-pool
    // roster, then ONE bulk booking query over those ids (a count per agent would
    // spend the subrequest budget this lane shares with three others). Both go
    // through `unwrap`, because a read that failed comes back empty and an empty
    // result here is indistinguishable from "nobody is holding anything", which
    // would post an all-clear over a real gap. ---
    const loadInactiveHolders = async () => {
      // cap-safe: `users` is roster-bounded (a fixed 100-200 agent target), so the
      // out-of-pool subset can never fill a PostgREST page.
      const agents = (unwrap(
        await db
          .from("users")
          .select("id, name, email, deactivated_at")
          .or("bookable.eq.false,deactivated_at.not.is.null")
          .eq("is_test", false),
        "monitor inactive-agent roster",
      ) ?? []) as { id: string; name: string | null; email: string | null; deactivated_at: string | null }[];
      if (agents.length === 0) return [];
      const outOfPool: OutOfPoolAgent[] = agents.map((a) => ({
        id: a.id,
        name: a.name,
        email: a.email,
        deactivated: a.deactivated_at !== null,
      }));
      // Every page: an offboarding backlog can hold more than 1,000 upcoming
      // bookings between them, and a truncated page would under-report the gap.
      const bookings = await selectAllPages<{ assigned_user_id: string | null }>(
        "monitor inactive-agent bookings",
        (from, to) =>
          db
            .from("bookings")
            .select("assigned_user_id")
            .in("assigned_user_id", outOfPool.map((a) => a.id))
            .in("status", ACTIVE_BOOKING_STATUSES)
            .gte("starts_at", new Date(now).toISOString())
            .range(from, to),
      );
      return inactiveHoldersFromBookings(outOfPool, bookings);
    };
    const inactiveBookings = await runInactiveAgentBookingsCheck({
      loadHolders: loadInactiveHolders,
      cooldownMs: settings.cooldownMs.inactive_agent_bookings,
      log: (fields) => log.info("inactive-agent-bookings", { msg: "tick", ...fields }),
    });

    // --- Appointments a coverage sweep GAVE UP on (#1242). The complement of the
    // check above: that one measures agents out of the pool, this one measures the
    // sweep's own terminal outcomes, so it covers every origin (admin panel, an
    // approved absence, offboarding) including agents who are still active. Both
    // reads go through `unwrap`, because an unread worklist comes back empty and an
    // empty result here is indistinguishable from "nothing is stranded", which
    // would post an all-clear over a real gap. ---
    const loadStrandedHolders = async () => {
      const items = await selectAllPages<{ booking_id: string; status: string; job_id: string }>(
        "monitor stranded coverage items",
        (from, to) =>
          db
            .from("bulk_reassign_items")
            .select("booking_id, status, job_id")
            .in("status", ACTIONABLE_ITEM_STATUSES)
            .range(from, to),
      );
      if (items.length === 0) return [];
      // Only an UPCOMING appointment needs a person: a stranded one that has passed
      // is history, and paging about it would never clear.
      const bookings = (unwrap(
        await db
          .from("bookings")
          // cap-safe: primary-key lookup of the (few) stranded items' bookings.
          .select("id")
          .in("id", items.map((it) => it.booking_id))
          .in("status", ACTIVE_BOOKING_STATUSES)
          .gte("starts_at", new Date(now).toISOString()),
        "monitor stranded coverage bookings",
      ) ?? []) as { id: string }[];
      const upcoming = new Set(bookings.map((b) => b.id));
      const live = items.filter((it) => upcoming.has(it.booking_id));
      if (live.length === 0) return [];
      // The out agent lives on the job, so resolve the (few) jobs these belong to.
      const jobs = (unwrap(
        await db
          .from("bulk_reassign_jobs")
          // cap-safe: primary-key lookup of the jobs the stranded items belong to.
          .select("id, out_user_id")
          .in("id", [...new Set(live.map((it) => it.job_id))]),
        "monitor stranded coverage jobs",
      ) ?? []) as { id: string; out_user_id: string }[];
      const outByJob = new Map(jobs.map((j) => [j.id, j.out_user_id]));
      const stranded: StrandedAppointment[] = live.flatMap((it) => {
        const outUserId = outByJob.get(it.job_id);
        return outUserId
          ? [{ bookingId: it.booking_id, outUserId, status: it.status as StrandedStatus }]
          : [];
      });
      if (stranded.length === 0) return [];
      const agents = (unwrap(
        await db
          .from("users")
          // cap-safe: primary-key lookup of the affected out agents.
          .select("id, name, email")
          .in("id", [...new Set(stranded.map((s) => s.outUserId))]),
        "monitor stranded coverage agents",
      ) ?? []) as CoverageOutAgent[];
      return strandedHoldersFromItems(stranded, agents);
    };
    const strandedCoverage = await runCoverageNeedsHumanCheck({
      loadStranded: loadStrandedHolders,
      cooldownMs: settings.cooldownMs.coverage_needs_human,
      log: (fields) => log.info("coverage-needs-human", { msg: "tick", ...fields }),
    });

    // Schema behind the deployed code (#516). Deploys do not apply migrations, so
    // code can go live expecting a column, table, or function the database lacks;
    // the failure is usually silent (0055 left the dead-man's switch dormant for a
    // whole session). CI guards merge time, this guards PROD. Cheap: one RPC.
    // A read that fails pages as "unverified" rather than passing as healthy.
    const migrationStatus = await runMigrationDriftCheck({
      shippedVersion: SHIPPED_MIGRATION_VERSION,
      readAppliedVersions: readAppliedMigrationVersions,
      notify: sendThrottledAlert,
      // #1134: say so when the schema catches up. This page is cleared by a human
      // running a migration, so silence afterwards is ambiguous: it looks the same
      // as the cooldown still running.
      // all-clear-proof: scripts/test-migration-drift.ts - an unreadable applied
      // set is classified unverified and never announces recovery.
      resolve: resolveAlert,
      cooldownMs: settings.cooldownMs.migration_version_lag,
      log: (msg, status, applied) =>
        log.info("migration-drift", {
          msg,
          status,
          shipped: SHIPPED_MIGRATION_VERSION,
          // A full set of ~70+ versions per tick is log noise; the count is enough
          // for forensics and the alert itself names any missing versions.
          appliedCount: applied?.length ?? null,
        }),
    });

    // Watch the other lanes (#803). The sync lane does this too; running it from
    // BOTH means the every-minute lanes and the 5-minute lanes watch each other,
    // so whichever survives a killed invocation reports the one that didn't. The
    // per-lane alert cooldown dedupes the overlap. Never throws.
    await alertOnStaleLanes();

    // Reliable trigger for the booking smoke canary (#525 follow-up). GitHub
    // scheduled runs are best-effort and get dropped under load (2-3h gaps against
    // the 30-min cadence), so the canary heartbeat aged past its 90m bound and the
    // watchdog above paged even though the booking path was healthy. This reliable
    // lane fills the gap: only when the heartbeat is stale does it fire the workflow
    // via GitHub's API, throttled by a NOT-released dispatch lock so it can't
    // double-fire. GitHub's own schedule stays on as a backup (the smoke-canary
    // concurrency group dedupes overlap). Quiet no-op until GITHUB_CANARY_TOKEN is
    // set. Never throws.
    // Both canary gap-fills (#525 dry + #982 full) in one tested helper: each fires
    // its workflow pass only when its OWN heartbeat is stale (GitHub dropped that
    // run), throttled by its own NOT-released dispatch lock so it can't double-fire.
    // The full pass creates real bookings on the SMOKE test agents (webhooks are
    // suppressed for is_test), the same side effect as the scheduled 6h run; the
    // lane-watchdog backstop still pages if both GitHub AND the gap-fill fail it.
    // Quiet no-op until GITHUB_CANARY_TOKEN is set. Never throws.
    const canaryToken = githubCanaryToken();
    await runCanaryGapFills({
      now,
      token: canaryToken,
      readHeartbeatMs,
      acquireLock: async (name, ttl) => (await acquireLock(name, ttl)) !== null,
      dispatch: (mode) => postCanaryWorkflowDispatch(canaryToken, mode),
      onInfo: (msg) => log.info("canary-trigger", { msg }),
      onError: (msg, err) => log.error("canary-trigger", { msg }, err),
    }).catch((err) => log.error("canary-trigger", { msg: "gap-fill threw" }, err));

    // --- cal.com override sweep (#1253) -------------------------------------
    //
    // Retry an approved absence whose cal.com override FAILED, while it still
    // matters, and page once the absence is actually under way with no block in
    // place (from that moment a real customer can book someone who is away).
    //
    // Keyed on a recorded failure, never on `calcom_synced`: 631 approved requests
    // predate the dual-write and carry no cal.com outcome, so a flag-keyed sweep
    // would fire hundreds of writes for absences long past.
    //
    // It lives on this lane rather than a new one because this lane already both
    // heals and alerts (it recomputes caches and fills missing schedules), and
    // because the every-minute invocation is short of CPU headroom (#1245).
    const overrideSweep = await runCalcomOverrideSweep({
      nowMs: now,
      loadCandidates: () => loadFailedOverrideCandidates(db),
      retry: (requestId) => retryOverrideForRequest(db, requestId),
      alert: async (key, text) => {
        // alert-key: ooo_calcom_unprotected
        // alert-text-ok: our own copy from calcom-override-sweep.ts, never a raw error.
        await sendThrottledAlert(key, settings.cooldownMs.ooo_calcom_unprotected, text);
      },
      // alert-key: ooo_calcom_unprotected
      resolve: (key, text) => resolveAlert(key, text),
      log: (msg) => log.info("calcom-sweep", { msg }),
    }).catch((err) => {
      log.error("calcom-sweep", { msg: "sweep threw" }, err);
      return null;
    });

    // Stamp the dead-man's switch (#420): proves this lane ran this tick.
    // Best-effort — must never affect the monitor's own response.
    await recordHeartbeat("monitor").catch(() => {});

    return NextResponse.json({
      buckets: buckets.length,
      failing: page.length,
      codes: page,
      fallbackCovered: covered,
      thinTiers: thinTierCount,
      scheduleCoverage,
      attributeCoverage,
      syncStaleness: {
        stale: syncStaleness.staleCount,
        worstNeverSynced: syncStaleness.worstNeverSynced,
        worstAgeMs: syncStaleness.worstAgeMs,
      },
      overrideSweep,
      inactiveBookings,
      strandedCoverage,
      migration: { status: migrationStatus, shipped: SHIPPED_MIGRATION_VERSION },
      truncated,
      volume,
    });
  } finally {
    await releaseLock("cron_monitor", lock);
  }
}
