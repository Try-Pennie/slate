/**
 * The calendar hydration rotation (#1261): which calendars get re-bootstrapped this tick,
 * and over what window.
 *
 * WHY RE-BOOTSTRAP AT ALL, when the sync token already streams changes. Google's delta is
 * NOT scoped to the window the bootstrap asked for (measured, #1252), and an unchanged
 * event is delivered exactly ONCE. So the moment anything filters or prunes the cache by
 * window, a far future event created and never touched again is dropped and never re-added
 * when the horizon slides up to it. Hydration is what makes that filter safe, which is why
 * it ships first and runs alone for a full cycle before #1264 lands.
 *
 * Pure, and free of Cloudflare and Supabase imports, so every branch is driven offline by
 * scripts/test-calendar-hydration.ts.
 */
import { logAlertSendFailure, logResolveFailure } from "../notify/send-failure.ts";
import {
  BOOTSTRAP_LOOKBACK_MS,
  BUSY_WINDOW_AHEAD_DAYS,
  eligibleCalendarsForSync,
} from "@/lib/google/sync-coalesce";
import { parseStampMs } from "@/lib/date/stamp";
import { MAX_ONBOARDS_PER_TICK } from "@/lib/google/sync-pace";
import type { AlertResolve, ThrottledNotify } from "@/lib/monitor/alert-deps";

/** Ticks a day at the lane's every-fifteen-minutes trigger. Written in words rather than
 *  as the cron expression because a slash-star inside a block comment closes it. Its own
 *  expression, never the every-minute invocation, which is the one already short of CPU
 *  headroom (#1245). */
export const HYDRATION_TICKS_PER_DAY = 96;

/** Never fetch fewer than this, so a small or briefly-unreadable roster still makes
 *  progress instead of rounding down to nothing. */
export const HYDRATION_MIN_BATCH = 2;

/**
 * How many NEVER ATTEMPTED calendars one tick may take on top of the maintenance batch
 * (#2301).
 *
 * Derived from the lane that creates the rows rather than chosen. The watch lane admits
 * at most `MAX_ONBOARDS_PER_TICK` brand new agents per tick, so an allowance below that
 * could never keep up with its own supply, and the arithmetic is asserted in
 * scripts/test-calendar-hydration.ts so a change to either constant has to be a decision
 * about both.
 *
 * It is a bound on the COUNT, not the only bound: the lane's own `HYDRATE_BUDGET_MS`
 * deadline still stops the tick. Both exist because they answer different questions. The
 * deadline stops a slow tick, and this stops a mass onboarding turning one tick into a
 * run over the whole wave, with the remainder taken on the next cadence rather than
 * truncated silently mid loop.
 */
export const HYDRATION_ONBOARDING_MAX = MAX_ONBOARDS_PER_TICK;

/**
 * How many calendars to refresh this tick, DERIVED from the live count.
 *
 * A hardcoded number is the failure this exists to avoid. Five an hour is 120 a day, which
 * clears 119 calendars with no slack at all, and at the design target of 100 to 200 agents
 * it silently becomes a refresh every OTHER day while the safety margin erodes and nothing
 * reports it. Deriving it means the cadence holds at any roster size, and the property is
 * asserted as arithmetic in the test rather than trusted.
 */
export function hydrationBatchSize(calendarCount: number): number {
  const needed = Math.ceil(Math.max(0, calendarCount) / HYDRATION_TICKS_PER_DAY);
  return Math.max(HYDRATION_MIN_BATCH, needed);
}

/**
 * The bounds this pass will send to Google.
 *
 * Returned together, and passed onward together, because the reconcile that follows may
 * only judge what the fetch actually asked for. Re-reading a stored window instead is the
 * one shape that can over-delete: a stored value larger than what was sent would extend
 * the reconcile past the fetch and remove cached busy time nothing had read.
 */
export function hydrationWindow(nowMs: number): { timeMinIso: string; timeMaxIso: string } {
  return {
    timeMinIso: new Date(nowMs - BOOTSTRAP_LOOKBACK_MS).toISOString(),
    timeMaxIso: new Date(nowMs + BUSY_WINDOW_AHEAD_DAYS * 24 * 60 * 60_000).toISOString(),
  };
}

/** The columns this rotation needs off a calendar row. */
export interface HydrationCandidate {
  id: string;
  sync_token: string | null;
  last_failure_kind: "gone" | "not-provisioned" | "transient" | null;
  consecutive_failures: number;
  last_bootstrap_attempt_at: string | null;
  /** #2411: who holds the calendar right now. Required, so `tsc` names every
   *  construction site rather than letting a row that omitted it read as free. */
  sync_claimed_at: string | null;
}

/**
 * This tick's batch: the least recently ATTEMPTED calendars first, capped at `batchSize`.
 *
 * Two things make the ordering safe.
 *
 * It keys on the ATTEMPT stamp, not on success. Ordering by coverage would let a calendar
 * whose delegation has been revoked stay the oldest forever, so it would be selected first
 * on every single tick and starve every healthy calendar behind it.
 *
 * And it applies the SHARED eligibility predicate, so an established-gone calendar is held
 * back to its periodic retry slot rather than consuming a place in every batch. Shared
 * rather than re-implemented: a second copy of "is this calendar worth attempting" would
 * drift from the one the every-minute lane uses, and #1396 is what happens when a caller
 * hand-rolls that test instead.
 *
 * An unreadable or missing stamp sorts as never attempted, the fail-safe side. `Date.parse`
 * returns NaN for a value it cannot read and NaN compares false against everything, so a
 * raw comparison would silently park such a calendar at the back of the queue forever (L50).
 */
export function calendarsDueForHydration<T extends HydrationCandidate>(
  calendars: T[],
  nowMs: number,
  batchSize: number,
): T[] {
  if (batchSize <= 0) return [];
  const eligible = eligibleCalendarsForSync(calendars, nowMs);
  // Number.NEGATIVE_INFINITY for "never attempted", so it sorts ahead of every real stamp
  // without any special case in the comparator.
  const attemptedAt = (c: T): number =>
    parseStampMs(c.last_bootstrap_attempt_at) ?? Number.NEGATIVE_INFINITY;

  // #2301: onboarding, taken IN ADDITION to the batch rather than out of it.
  //
  // The test is `last_bootstrap_attempt_at === null` and deliberately NOT "sorts as never
  // attempted". An UNREADABLE stamp also sorts first, and it is a different fact: it can
  // belong to a calendar established for months whose stamp is corrupt. Letting it in here
  // would let corrupt rows crowd genuinely new calendars out of a bounded allowance, so it
  // keeps the head-of-queue maintenance treatment it already had.
  //
  // Because the stamp is written BEFORE the fetch, a calendar whose bootstrap failed is no
  // longer null and drops back into the ordinary rotation. That is what stops a permanently
  // failing calendar taking an onboarding slot on all 96 ticks of the day, and it is the
  // property worth not breaking if this is ever refactored.
  const onboarding = eligible
    .filter((c) => c.last_bootstrap_attempt_at === null)
    .slice(0, HYDRATION_ONBOARDING_MAX);
  const onboardingIds = new Set(onboarding.map((c) => c.id));

  const maintenance = eligible
    .filter((c) => !onboardingIds.has(c.id))
    .sort((a, b) => attemptedAt(a) - attemptedAt(b))
    .slice(0, batchSize);
  return [...onboarding, ...maintenance];
}

/** alert_state key for the rotation's own failure signal (#1544). */
export const HYDRATION_FAILING_KEY = "hydration_all_failing";

/**
 * What one tick of the rotation measured about ITSELF.
 *
 * WHY THIS IS NEEDED AT ALL, given each calendar already records its own health.
 * `hydrateCalendar` writes a failure to the SYNC lane's columns, the same ones the
 * every-minute incremental sync writes, and every success there resets the streak to zero.
 * The paging thresholds need 2 consecutive failures (4 for a transient), the rotation fails
 * at most once per tick, and the sync wipes the count within the next minute. So the streak
 * can never build and a rotation failing on EVERY calendar raises nothing, while its
 * heartbeat keeps stamping because that is written whether the work succeeded or not. A dead
 * lane and a healthy one are then identical from outside (L53, the mistake #1150 already
 * fixed once by giving the watch lane its own columns).
 *
 * Three outcomes, and `unmeasured` is the one that matters. A tick with nothing due
 * legitimately happens when the shared eligibility gate holds every candidate back, and
 * scoring it either way is wrong: as healthy it would CLEAR a real page, as failure it would
 * page about a lane with nothing to do (#1134, #1152).
 *
 * A tick that refreshed SOMETHING is healthy. One bad calendar among several is not this
 * signal's job; per-calendar visibility needs its own health columns and is #1545.
 */
export type HydrationTickVerdict = "healthy" | "all-failed" | "unmeasured";

/**
 * The part of a tick the verdict may be computed over (#2411).
 *
 * A calendar this tick SKIPPED, because another pass held its claim or advanced its
 * token mid-fetch, was never attempted against Google, so it is neither a refresh
 * nor a failure. Leaving it in the denominator is what makes this necessary rather
 * than tidy: a tick whose whole batch was skipped would otherwise arrive as
 * `refreshed = 0` out of a non-zero `due`, which reads as `all-failed`, and four of
 * those in a row would page about a rotation with nothing wrong with it (L11, #1544).
 *
 * Taking them out instead collapses an all-skipped tick to `due = 0`, which is
 * already the lane's own word for a tick that measured nothing, and which neither
 * pages nor all-clears (#1134, #1152). Skips are reported as their own count, so a
 * lane held back every tick is visible rather than silent.
 */
export function hydrationMeasuredTick(tick: {
  due: number;
  refreshed: number;
  failed: number;
  skipped: number;
}): { due: number; refreshed: number; failed: number } {
  return {
    due: Math.max(0, tick.due - Math.max(0, tick.skipped)),
    refreshed: tick.refreshed,
    failed: tick.failed,
  };
}

export function hydrationTickVerdict(tick: {
  due: number;
  refreshed: number;
  failed: number;
}): HydrationTickVerdict {
  const { due, refreshed, failed } = tick;
  // Counts that contradict each other are not a measurement. A verdict computed from them
  // would be a confident answer about numbers nothing produced.
  if (due < 0 || refreshed < 0 || failed < 0) return "unmeasured";
  if (refreshed + failed > due) return "unmeasured";
  if (due === 0) return "unmeasured";
  return refreshed > 0 ? "healthy" : "all-failed";
}

/**
 * The Slack text. A builder rather than a literal at the send site, so
 * `pnpm preview:alerts` renders exactly what ships (L41).
 */
export function formatHydrationFailingAlert(input: {
  due: number;
  consecutiveTicks: number;
}): string {
  const calendars =
    input.due === 1 ? "the one calendar it tried" : `all ${input.due} calendars it tried`;
  return (
    `The calendar refresh has failed on ${calendars}, ` +
    `${input.consecutiveTicks} runs in a row. ` +
    // What is NOT broken, first: without this the reader assumes bookings are failing and
    // treats a slow-burning maintenance problem as an outage.
    "Customers are unaffected right now and bookings are working: the minute-by-minute sync " +
    "is still keeping availability fresh, so nobody is being offered a time an agent is busy " +
    "in. What has stopped is the daily full refresh that keeps the cached window from " +
    "expiring, and if it stays stopped that cover slowly goes stale. " +
    "Check the server logs under tag=hydrate-calendars for the reason, which is usually " +
    "Google delegation or a mailbox that no longer exists."
  );
}

/** The all-clear. Same reason for being a builder (L41). */
export function formatHydrationRecovery(): string {
  return (
    "The calendar refresh is working again. Its last run re-read at least one calendar " +
    "successfully, so the daily rotation is progressing and cached cover is being renewed."
  );
}

/**
 * The tick's alerting step, with IO injected so all three outcomes, including the two that
 * must send nothing, are exercised offline (scripts/test-hydration-tick-verdict.ts).
 *
 * Extracted from the route rather than inlined there for the usual reason: the branch that
 * must stay SILENT is the one worth testing, and a branch inside a cron handler is reachable
 * only by standing up the whole handler.
 */
export async function runHydrationTickCheck(deps: {
  tick: { due: number; refreshed: number; failed: number };
  /** True once the all-failed streak has reached its threshold. */
  recordStreak: () => Promise<boolean>;
  clearStreak: () => Promise<unknown>;
  notify: ThrottledNotify;
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
  consecutiveTicks: number;
}): Promise<HydrationTickVerdict> {
  const verdict = hydrationTickVerdict(deps.tick);

  if (verdict === "all-failed") {
    const overThreshold = await deps.recordStreak().catch(() => false);
    if (overThreshold) {
      const text = formatHydrationFailingAlert({
        due: deps.tick.due,
        consecutiveTicks: deps.consecutiveTicks,
      });
      // swallow-ok: a failed alert must not fail the lane, or a Slack outage would stop the
      // refresh itself. The streak is already recorded, so the condition is still true and
      // the next tick re-attempts; nothing is lost but this one send.
      await deps.notify(HYDRATION_FAILING_KEY, deps.cooldownMs, text).catch(logAlertSendFailure(HYDRATION_FAILING_KEY));
    }
    return verdict;
  }

  if (verdict === "healthy") {
    // swallow-ok: the reset is best effort. A miss leaves a stale count the next healthy
    // tick clears, and the window expires on its own, so the worst case is one late
    // all-clear rather than a lost signal.
    await deps.clearStreak().catch(() => {});
    // swallow-ok: a failed all-clear leaves the condition showing as open, which is the safe
    // direction, and the next healthy tick re-sends it.
    await deps.resolve(HYDRATION_FAILING_KEY, formatHydrationRecovery()).catch(logResolveFailure(HYDRATION_FAILING_KEY));
    return verdict;
  }

  // Unmeasured: neither pages nor clears. A tick that learned nothing must never announce a
  // recovery (#1134, #1152), and must never page about a lane with nothing to do.
  return verdict;
}
