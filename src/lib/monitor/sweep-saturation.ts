import { recordConsecutiveStreak, clearFailureStreak } from "@/lib/notify/streak";
import { sendThrottledAlert, resolveAlert } from "@/lib/notify/dispatch";
import {
  MAX_COMPLETION_DRAIN_BATCHES,
  PAST_COMPLETION_BATCH_LIMIT,
} from "@/lib/booking/core";

/**
 * Saturation signal for the bounded self-heal sweeps (#726).
 *
 * The #428 cancelled-block reconcile frees at most `RECONCILE_LIMIT` busy_blocks
 * per tick, and #431 re-creates at most that many. A backlog larger than the drain
 * rate (a mass cancel, a bad deploy) clears slowly and with NO signal: every tick
 * reports a full batch and looks healthy. The #440 soak needed 11 ticks to clear
 * ~1850 orphans.
 *
 * A tick that hits its cap is "saturated": there was at least as much work as the
 * sweep could do, so more is probably waiting. One saturated tick is normal (a
 * burst clears on the next tick), so we page only when saturation is SUSTAINED
 * across consecutive ticks. The streak itself is counted by the shared
 * `recordConsecutiveStreak` helper, which is atomic in the database.
 */

/** Consecutive saturated ticks before the sweep pages. The lane runs once a
 *  minute, so this is 5 minutes of draining flat out. A single burst of
 *  cancellations clears well inside it. */
export const SATURATION_ALERT_AFTER_TICKS = 5;

/** Streak window. Must comfortably exceed the 1/min lane interval so consecutive
 *  ticks land in the same window, with room for a tick delayed by lock contention. */
export const SATURATION_WINDOW_SECONDS = 15 * 60;

/**
 * Whether a tick hit its drain cap. `drained` is null when the sweep threw: a
 * failed tick says nothing about backlog size, so it is neither saturation (which
 * would be a lie) nor evidence the backlog cleared. Sweep failures alert on their
 * own path.
 */
export function isSweepSaturated(drained: number | null, limit: number): boolean {
  return drained !== null && drained >= limit;
}

/** Page body. `ticks` is the threshold that was crossed, so the wording says "at
 *  least": once the streak alerts it keeps alerting, and claiming an exact
 *  duration would understate a long outage. No em/en dashes (copy lint). */
export function formatSaturationAlert(sweep: string, ticks: number, limit: number): string {
  return (
    `Slate: the ${sweep} sweep has been draining at its cap (${limit} per tick) for at ` +
    `least ${ticks} consecutive minute(s). The backlog is growing faster than the sweep ` +
    `can clear it, so stuck slots are staying stuck. Check for a mass cancel or a failing ` +
    `cancel path, and consider raising the per tick cap.`
  );
}

/** Cooldown between saturation pages while a backlog is being worked. */
const SATURATION_ALERT_COOLDOWN_MS = 30 * 60_000;

/**
 * All-clear for a capped sweep (#1134). Says the backlog is gone and that there
 * is nothing to do, and deliberately does NOT repeat the page's remediation
 * ("consider raising the per tick cap"): the reader is being told to stand down,
 * and carrying the fix-it text into the all-clear is how a resolve message ends up
 * sending someone to tune a cap that no longer needs tuning.
 */
export function formatSaturationRecovery(sweep: string): string {
  return (
    `Slate: the ${sweep} sweep has caught up. It is draining under its per tick cap ` +
    `again, so the backlog that triggered the earlier page has cleared and nothing is ` +
    `stuck waiting on it. No action is needed.`
  );
}

/** All-clear for the completion sweep (#1134). Answers the specific worry its page
 *  raised, that finished bookings' completed webhooks were being delayed. */
export function formatCompletionSaturationRecovery(): string {
  return (
    `Slate: the booking completion sweep has caught up. Finished bookings are being ` +
    `marked complete inside the per run budget again, and the booking.completed ` +
    `webhooks that were being delayed have gone out. No action is needed.`
  );
}

/** All-clear for the failed-deletion drain (#1134). Answers its page's specific
 *  worry, that cancelled bookings were leaving orphaned calendar reminders. */
export function formatDeletionSaturationRecovery(): string {
  return (
    `Slate: the failed calendar event deletion drain has caught up. Queued deletions ` +
    `are clearing under the per tick cap again, so cancelled bookings are no longer ` +
    `at risk of leaving orphaned calendar reminders. No action is needed.`
  );
}

/**
 * Shared streak+page core for the capped sweeps. `saturated` is the sweep's own
 * verdict for this run: `true` = it hit its budget with work still waiting,
 * `false` = it kept up (clear the streak), `null` = it threw and tells us nothing
 * (leave the streak untouched, never page). Pages once the saturated streak
 * reaches `alertAfter` consecutive runs, then the cooldown throttles the repeats.
 *
 * Best-effort by design: monitoring must never take down the lane it is watching,
 * so alert dispatch is caught and the streak helpers swallow their own errors.
 */
async function pageOnSaturationStreak(
  key: string,
  saturated: boolean | null,
  windowSeconds: number,
  alertAfter: number,
  cooldownMs: number,
  buildAlert: (runs: number) => string,
  recoveryText: string,
): Promise<void> {
  if (saturated === null) return;
  if (!saturated) {
    await clearFailureStreak(key);
    // #1134: an under-cap run IS the recovery, so the all-clear hangs off the
    // healthy path rather than off a failure branch it could never reach.
    // `resolveAlert` is a no-op unless a page was actually delivered, so a sweep
    // that never alerted stays silent. The `null` case above still returns first:
    // a sweep that threw knows nothing about the backlog and must no more announce
    // recovery than it counts as saturation.
    await resolveAlert(key, recoveryText).catch(() => {});
    return;
  }
  const sustained = await recordConsecutiveStreak(key, windowSeconds, alertAfter);
  if (!sustained) return;
  await sendThrottledAlert(key, cooldownMs, buildAlert(alertAfter)).catch(() => {});
}

/**
 * Fold one tick's drain count into the sweep's saturation streak, and page when the
 * streak is sustained.
 *
 * A tick under the cap clears the streak. A FAILED tick (`drained` null) does
 * neither: it is not saturation, and it is not evidence the backlog drained.
 */
export async function reportSweepSaturation(
  sweep: string,
  key: string,
  drained: number | null,
  limit: number,
): Promise<void> {
  const saturated = drained === null ? null : isSweepSaturated(drained, limit);
  await pageOnSaturationStreak(
    key,
    saturated,
    SATURATION_WINDOW_SECONDS,
    SATURATION_ALERT_AFTER_TICKS,
    SATURATION_ALERT_COOLDOWN_MS,
    (runs) => formatSaturationAlert(sweep, runs, limit),
    formatSaturationRecovery(sweep),
  );
}

/**
 * Saturation signal for the booking-completion sweep (#883, follow-up to #871).
 *
 * `completePastBookings` drains up to MAX_COMPLETION_DRAIN_BATCHES batches of
 * PAST_COMPLETION_BATCH_LIMIT finished bookings per run on the 5-minute complete
 * lane. When a run exhausts that budget with a full batch still waiting it sets
 * `backlogRemains` and emits a `log.warn`, but a log line pages nobody and only
 * lives 7 days. This turns a sustained streak of over-budget runs into a real page.
 *
 * Unlike the reconcile sweeps, the completion sweep reports its OWN boolean
 * verdict (`backlogRemains`) rather than a drained-vs-cap count: that flag is the
 * precise signal the drain loop already computes (a count could reach the product
 * of the caps while the backlog is in fact clear).
 */

/** Consecutive over-budget completion runs before paging. The complete lane runs
 *  every 5 minutes, so 3 runs is ~15 minutes of the sweep failing to keep up. A
 *  one-off backlog spike clears well inside it. */
export const COMPLETION_SATURATION_ALERT_AFTER_RUNS = 3;

/** Streak window. Must comfortably exceed 3 runs * 5 min = 15 min so genuinely
 *  consecutive runs land in the same window, with slack for a delayed tick. */
export const COMPLETION_SATURATION_WINDOW_SECONDS = 30 * 60;

/** Cooldown between completion-saturation pages while the backlog is worked. */
const COMPLETION_SATURATION_COOLDOWN_MS = 30 * 60_000;

/** The most finished bookings one run can clear (batch size * batch cap). */
const COMPLETION_DRAIN_BUDGET_PER_RUN =
  PAST_COMPLETION_BATCH_LIMIT * MAX_COMPLETION_DRAIN_BATCHES;

/** Page body. `runs` is the crossed threshold, so the wording says "at least".
 *  No em/en dashes (copy lint). */
export function formatCompletionSaturationAlert(runs: number, perRun: number): string {
  return (
    `Slate: the booking completion sweep has exhausted its per run drain budget ` +
    `(${perRun} finished bookings per run) for at least ${runs} consecutive runs. ` +
    `Finished bookings are piling up faster than the sweep can mark them complete, ` +
    `so their booking.completed webhooks are being delayed. Check for a backlog ` +
    `spike or a failing completion path, and consider raising the per run budget.`
  );
}

/**
 * Fold one completion run's over-budget verdict into its saturation streak, and
 * page when sustained. See `pageOnSaturationStreak` for the null/false/true rules.
 */
export async function reportCompletionSaturation(
  key: string,
  backlogRemains: boolean | null,
): Promise<void> {
  await pageOnSaturationStreak(
    key,
    backlogRemains,
    COMPLETION_SATURATION_WINDOW_SECONDS,
    COMPLETION_SATURATION_ALERT_AFTER_RUNS,
    COMPLETION_SATURATION_COOLDOWN_MS,
    (runs) => formatCompletionSaturationAlert(runs, COMPLETION_DRAIN_BUDGET_PER_RUN),
    formatCompletionSaturationRecovery(),
  );
}

/**
 * Saturation signal for the failed-deletion drain (#888, sibling of #883).
 *
 * `processPendingEventDeletions` re-attempts at most DELETION_DRAIN_LIMIT queued
 * calendar-event deletions per self-heal tick. A backlog bigger than that clears
 * slowly or never, and every tick still reports a normal-looking full batch. The
 * lane runs 1/min like the reconciles, so it reuses their tick tuning.
 *
 * This is INDEPENDENT of the existing per-row "stuck" alert (a row that failed
 * PENDING_DELETION_ALERT_AFTER+ times). They measure different things: stuck says
 * one row is poisoned, saturation says the QUEUE is growing faster than the drain
 * rate even when every delete succeeds. Both can be true at once and each throttles
 * separately.
 */

/** Page body. `ticks` is the crossed threshold, so the wording says "at least".
 *  No em/en dashes (copy lint). */
export function formatDeletionSaturationAlert(ticks: number, limit: number): string {
  return (
    `Slate: the failed calendar event deletion drain has been running at its cap ` +
    `(${limit} per tick) for at least ${ticks} consecutive minute(s). Queued deletions ` +
    `are arriving faster than the drain can clear them, so cancelled bookings may keep ` +
    `firing orphaned calendar reminders. Check Google Calendar API health and the cancel ` +
    `path, and consider raising the per tick cap.`
  );
}

/**
 * Fold one deletion-drain tick into its saturation streak, and page when sustained.
 * See `pageOnSaturationStreak` for the null/false/true rules.
 *
 * Takes the drain's whole result rather than a count because the saturation signal
 * is the size of the page it LOADED: `deleted + failed`. The delete count alone is
 * NOT the signal, and the reporter owns that sum so no call site can get it wrong.
 * A full page that failed every row is the worst case (the backlog cannot drain at
 * all), yet its `deleted` is 0, which a naive count check would read as a healthy,
 * under-cap tick and use to CLEAR the streak.
 */
export async function reportDeletionSaturation(
  key: string,
  drain: { deleted: number; failed: number } | null,
  limit: number,
): Promise<void> {
  const saturated = drain === null ? null : isSweepSaturated(drain.deleted + drain.failed, limit);
  await pageOnSaturationStreak(
    key,
    saturated,
    SATURATION_WINDOW_SECONDS,
    SATURATION_ALERT_AFTER_TICKS,
    SATURATION_ALERT_COOLDOWN_MS,
    (ticks) => formatDeletionSaturationAlert(ticks, limit),
    formatDeletionSaturationRecovery(),
  );
}
