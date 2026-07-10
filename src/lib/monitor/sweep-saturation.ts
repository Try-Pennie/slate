import { recordConsecutiveStreak, clearFailureStreak } from "@/lib/notify/streak";
import { sendThrottledAlert } from "@/lib/notify/dispatch";

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
 * Fold one tick's drain count into the sweep's saturation streak, and page when the
 * streak is sustained.
 *
 * A tick under the cap clears the streak. A FAILED tick (`drained` null) does
 * neither: it is not saturation, and it is not evidence the backlog drained. Alert
 * dispatch is best-effort, because monitoring must never take down the self-heal
 * lane it is watching.
 */
export async function reportSweepSaturation(
  sweep: string,
  key: string,
  drained: number | null,
  limit: number,
): Promise<void> {
  if (drained === null) return;
  if (!isSweepSaturated(drained, limit)) {
    await clearFailureStreak(key);
    return;
  }
  const sustained = await recordConsecutiveStreak(
    key,
    SATURATION_WINDOW_SECONDS,
    SATURATION_ALERT_AFTER_TICKS,
  );
  if (!sustained) return;
  await sendThrottledAlert(
    key,
    SATURATION_ALERT_COOLDOWN_MS,
    formatSaturationAlert(sweep, SATURATION_ALERT_AFTER_TICKS, limit),
  ).catch(() => {});
}
