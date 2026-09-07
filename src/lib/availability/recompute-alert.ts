import { RECOMPUTE_FRESH_MS } from "./precompute-cron";

/**
 * When the recompute lane's headroom page fires, and when it is allowed to say
 * it is over (#2021). Pure: the route hands in a streak store and the verdict
 * comes back, so `scripts/test-recompute-alert.ts` can replay a whole morning
 * of ticks against an in-memory store with an injected clock.
 *
 * Both sides are STREAKS, and the reason is one morning in Slack. On 2026-09-07
 * the lane ran at 101 to 123% of its budget with 62 hot buckets, so it alternated
 * two behind minutes with one caught-up minute for hours. The old rule paged on
 * the second behind cycle and announced recovery on the first drained one, and
 * the recovery wiped the cooldown, so every wobble was a fresh page and a fresh
 * all-clear while no bucket ever went stale (that alarm is separate and stayed
 * quiet). L160: a condition is only over once it has stayed healthy for a re-arm
 * window, never on the first healthy sample.
 *
 * A wobble like that is silent under these rules on purpose. The harm the lane
 * exists to prevent, a bucket serving stale availability, has its own alarm
 * (`bucket_slots_stale`), and a lag shorter than the freshness window cannot
 * produce it. What the silence hides is that the lane is running at its ceiling,
 * which is a capacity fact and belongs to a trend alert (#1246) and to #2022, not to a page
 * that fires twenty times a day and teaches everyone to skip it (L36).
 */

/** The lane runs once a minute. */
export const RECOMPUTE_CADENCE_MS = 60_000;

/**
 * Consecutive behind cycles before the page. DERIVED from the freshness window,
 * not declared beside it (the #1248 rule): one cycle longer than the window, so
 * a lag that cannot make any bucket stale stays silent, and widening the window
 * moves this threshold with it.
 */
export const RECOMPUTE_BEHIND_CYCLES = Math.floor(RECOMPUTE_FRESH_MS / RECOMPUTE_CADENCE_MS) + 1;

/** Consecutive caught-up cycles before the all-clear: the L160 re-arm window. */
export const RECOMPUTE_REARM_CYCLES = RECOMPUTE_BEHIND_CYCLES;

/**
 * The `rate_limit_hit` window each streak is counted in. It must hold the whole
 * streak comfortably, because the window is FIXED from the first hit and a hit
 * past its end starts the count again at one; twice the streak leaves room for a
 * late tick without ever splitting a genuine run in two.
 */
export const RECOMPUTE_STREAK_WINDOW_S =
  (2 * Math.max(RECOMPUTE_BEHIND_CYCLES, RECOMPUTE_REARM_CYCLES) * RECOMPUTE_CADENCE_MS) / 1000;

export const RECOMPUTE_BEHIND_STREAK_KEY = "cron_recompute_behind";
export const RECOMPUTE_DRAINED_STREAK_KEY = "cron_recompute_drained";

/**
 * The two operations the decision needs from `src/lib/notify/streak.ts`.
 * `bump` answers whether the streak has REACHED `alertAt` (and keeps answering
 * true on every hit after), and answers false on a tracking failure so a
 * streak is never invented; `clear` forgets the streak.
 */
export interface StreakStore {
  bump(key: string, windowSeconds: number, alertAt: number): Promise<boolean>;
  clear(key: string): Promise<void>;
}

export interface RecomputeCycleVerdict {
  /** The lane has been behind for the whole behind window: page (the cooldown throttles repeats). */
  page: boolean;
  /** The lane has kept up for the whole re-arm window: the condition is over. */
  recovered: boolean;
}

/**
 * Judge one cycle. A behind cycle grows the behind streak and forgets the
 * re-arm streak; a caught-up cycle does the reverse. Only a streak that has
 * reached its window speaks, in either direction.
 */
export async function judgeRecomputeCycle(
  drained: boolean,
  streaks: StreakStore,
): Promise<RecomputeCycleVerdict> {
  if (drained) {
    await streaks.clear(RECOMPUTE_BEHIND_STREAK_KEY);
    const recovered = await streaks.bump(
      RECOMPUTE_DRAINED_STREAK_KEY,
      RECOMPUTE_STREAK_WINDOW_S,
      RECOMPUTE_REARM_CYCLES,
    );
    return { page: false, recovered };
  }
  await streaks.clear(RECOMPUTE_DRAINED_STREAK_KEY);
  const page = await streaks.bump(
    RECOMPUTE_BEHIND_STREAK_KEY,
    RECOMPUTE_STREAK_WINDOW_S,
    RECOMPUTE_BEHIND_CYCLES,
  );
  return { page, recovered: false };
}
