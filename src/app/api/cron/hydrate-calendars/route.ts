import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import { acquireLock, releaseLock } from "@/lib/locks";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { withinBudget } from "@/lib/google/sync-pace";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { hydrateCalendar } from "@/lib/google/sync";
import {
  departedFromEmbed,
  planHydrationTick,
  runHydrationTickCheck,
  hydrationMeasuredTick,
  HYDRATION_FAILING_KEY,
} from "@/lib/google/hydration";
import { recordConsecutiveStreak, clearFailureStreak } from "@/lib/notify/streak";
import { sendThrottledAlert, resolveAlert } from "@/lib/notify/dispatch";
import { loadMonitorCooldowns } from "@/lib/monitor/settings";
import type { AgentCalendar } from "@/lib/db/types";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const LOCK_TTL_MS = 120_000;
/** Under the lock TTL, so a slow run can never outlive its own claim. */
const HYDRATE_BUDGET_MS = 90_000;

/** Consecutive all-failed ticks before this pages, and the window that must span them.
 *  Four ticks is an hour at this cadence: long enough that a batch of genuinely revoked
 *  calendars is not news, short enough to notice within a working morning. The window is
 *  comfortably wider, or consecutive runs would each look like the first. */
const ALL_FAILED_TICKS = 4;
const ALL_FAILED_WINDOW_SECONDS = 90 * 60;

/**
 * CALENDAR HYDRATION lane (#1261): re-bootstrap a slice of the calendars every tick, sized
 * so every calendar is refreshed at least once a day.
 *
 * WHY IT EXISTS. Google's incremental delta is NOT scoped to the window a bootstrap asked
 * for (measured, #1252), and an unchanged event is delivered exactly ONCE. So once anything
 * filters or prunes the cache by window (#1264, #1265), a far future event created and never
 * touched again would be dropped and never re-added when the horizon slid up to it. This
 * lane is what makes that filter safe, which is why it ships FIRST and runs alone for a full
 * rotation before the filter lands.
 *
 * ITS OWN CRON EXPRESSION, never the every-minute invocation, which is the one already short
 * of CPU headroom (#1245) and whose budget four lanes already share. Its own lock, and its
 * own heartbeat with a matching entry in LANE_STALE_BOUNDS_MS: a stamp no bound watches
 * looks like monitoring while nothing watches (#1123), and this lane going quiet means
 * coverage expiring everywhere with nothing saying so.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // #4222: claim this tick before any work, so the same lane sent twice runs once.
  const claimed = await claimLaneTick(req.headers, "/api/cron/hydrate-calendars");
  if (claimed) return claimed;
  // lock-overlap: each calendar is claimed (sync_claimed_at) and its sync token written
  // by compare and swap on the token the pass started from, so a stale overlapping pass
  // writes nothing.
  const lock = await acquireLock("cron_hydrate_calendars", LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });
  try {
    const db = supabaseAdmin();
    // Only a cooldown is needed here, so a settings blip must not stop the refresh
    // (#2773): last known cooldowns, else the coded ones, and the fallback is logged.
    const cooldownMs = await loadMonitorCooldowns("hydrate-calendars");
    const deadlineMs = Date.now() + HYDRATE_BUDGET_MS;

    // unwrap, not a bare destructure: a read error returning [] would look like "no
    // calendars to refresh" and this lane would report a clean run forever while coverage
    // quietly expired on every calendar. That is the exact shape the prune it authorizes
    // must never be built on.
    //
    // cap-safe: agent_calendars is roster-bounded config (153 rows on 2026-10-16, ~250 at
    // the design target), so it cannot fill a PostgREST page.
    const rows = (unwrap(
      await db
        .from("agent_calendars")
        .select(
          // #2411: sync_claimed_at is read so a calendar another pass is holding is
          // not taken into this batch at all. Without it the pass would claim, lose,
          // and spend one of the batch's places on a calendar it never refreshed.
          //
          // #3805: the agent's deactivated_at comes in the SAME read, embedded through
          // the one foreign key to users, so whether somebody has left can never be
          // missing on its own: a failed read throws above, and a row without its embed
          // throws in departedFromEmbed, rather than either reading as "still here".
          "id, user_id, calendar_id, sync_token, sync_claimed_at, last_failure_kind, consecutive_failures, last_bootstrap_attempt_at, last_success_at, last_sync_error, users(deactivated_at)",
        ),
      "hydrate-calendars calendar list",
    ) ?? []) as (AgentCalendar & { users: unknown })[];
    const calendars = rows.map(({ users, ...cal }) => ({
      ...(cal as AgentCalendar),
      departed: departedFromEmbed(users),
    }));

    // #3805: departed agents' calendars are left out, and the batch is sized over what is
    // left. Still derived from the LIVE count, never hardcoded: a fixed batch is right at
    // today's roster and silently halves the refresh rate as the roster grows.
    const plan = planHydrationTick(calendars, Date.now());
    const { batchSize, due, neverCovered, onboardingDeferred, departedSkipped } = plan;

    let refreshed = 0;
    let failed = 0;
    let skipped = 0;
    let events = 0;
    let budgetHit = false;
    for (const candidate of due) {
      if (!withinBudget(Date.now(), deadlineMs)) {
        budgetHit = true;
        break;
      }
      const res = await hydrateCalendar(candidate);
      // #2411: three outcomes, not two. A pass that DECLINED to run (another writer
      // holds the calendar, or advanced its token mid-fetch) attempted nothing against
      // Google, so calling it a failure would page about a healthy rotation and calling
      // it a refresh would claim coverage nobody established.
      if (res.skipped) skipped++;
      else if (res.ok) refreshed++;
      else failed++;
      events += res.events;
    }

    // #1544: the lane's own failure signal. Each calendar records its failure against the
    // SYNC lane's health columns, which the every-minute incremental sync resets to zero on
    // every success, so a rotation failing on EVERY calendar can never build the streak
    // those thresholds need. Its heartbeat keeps stamping regardless, because that is
    // written whether the work succeeded or not, so without this a dead lane and a healthy
    // one are identical from outside (L53).
    //
    // Judged over CONSECUTIVE ticks rather than one: today's batch is 2, so two genuinely
    // revoked calendars landing in one batch is an ordinary event and paging on it would be
    // the alert nobody reads (L36).
    const verdict = await runHydrationTickCheck({
      tick: hydrationMeasuredTick({ due: due.length, refreshed, failed, skipped }),
      // The window comfortably spans the ticks it counts (4 ticks at 15 minutes is an hour),
      // or genuinely consecutive runs would each look like the first.
      recordStreak: () =>
        recordConsecutiveStreak(
          HYDRATION_FAILING_KEY,
          ALL_FAILED_WINDOW_SECONDS,
          ALL_FAILED_TICKS,
        ),
      clearStreak: () => clearFailureStreak(HYDRATION_FAILING_KEY),
      // alert-key: hydration_all_failing
      // alert-text-ok: our own copy from hydration.ts, never a raw error.
      notify: sendThrottledAlert,
      // A condition: it stays true until somebody fixes the cause, so it has to be able to
      // end.
      // alert-key: hydration_all_failing
      // all-clear-proof: scripts/test-hydration-tick-verdict.ts - an unmeasured tick is its
      // own outcome and neither pages nor clears.
      resolve: resolveAlert,
      cooldownMs: cooldownMs.hydration_all_failing,
      consecutiveTicks: ALL_FAILED_TICKS,
    });

    // Stamped on every completed tick, including one that refreshed nothing: the watchdog's
    // question is whether this lane is RUNNING, and a tick that legitimately found nothing
    // due is a healthy tick. What must never be silent is the lane stopping.
    await recordHeartbeat("hydrate-calendars");

    // `budget_hit` is logged rather than only returned: a tick that stopped on its budget
    // and a tick that finished its batch both answer 200, and without saying which, a
    // cadence too slow for the roster is indistinguishable from a healthy rotation.
    log.info("hydrate-calendars", {
      msg: "cycle",
      calendars: calendars.length,
      departed_skipped: departedSkipped,
      batch: batchSize,
      due: due.length,
      never_covered: neverCovered,
      onboarding_deferred: onboardingDeferred,
      refreshed,
      failed,
      skipped,
      events,
      budget_hit: budgetHit,
      verdict,
    });
    return NextResponse.json({
      calendars: calendars.length,
      departedSkipped,
      batch: batchSize,
      neverCovered,
      onboardingDeferred,
      refreshed,
      failed,
      skipped,
      events,
      budgetHit,
      verdict,
    });
  } finally {
    await releaseLock("cron_hydrate_calendars", lock);
  }
}
