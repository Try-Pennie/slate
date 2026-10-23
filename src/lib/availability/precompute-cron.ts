import { log } from "@/lib/log";
import { scheduleAnchorMs } from "./slot-row-times.ts";
/**
 * Pure ordering/staleness helpers for the cron backstop (Phase 3). The cron
 * recomputes buckets changed this tick FIRST, then rotates through the
 * least-recently-computed of the rest within its time budget — which also slides
 * the day-window forward for buckets whose agents didn't change. Kept pure so the
 * rotation + staleness logic is unit-testable.
 */

export interface KnownRow {
  code: string;
  /** The row's stamp (`computed_at`): how old the data it was computed from is. */
  computedAtMs: number;
  /**
   * When the compute that wrote the row began (`compute_started_at`, #3388). Every
   * helper here that asks whether the lane is keeping up reads the row through
   * `anchorMs`, which takes this when the stamp can explain it. Absent or null (a row
   * from before migration 0201, or the column not there yet) means the stamp.
   */
  startedAtMs?: number | null;
}

/** The instant this row is scheduled and judged stale from (`scheduleAnchorMs`). */
function anchorMs(k: KnownRow): number {
  return scheduleAnchorMs(k.computedAtMs, k.startedAtMs);
}

/**
 * Recompute order: `touched` buckets first (in the given order), then every other
 * known/all bucket ordered least-recently-computed first (never-computed = 0, so
 * they sort to the front). No duplicates. The caller recomputes in this order
 * until its budget runs out; the tail is picked up on later ticks.
 */
export function orderBucketsForRecompute(
  touched: string[],
  known: KnownRow[],
  allCodes: string[],
): string[] {
  const computedAt = new Map(known.map((k) => [k.code, anchorMs(k)]));
  const seen = new Set(touched);
  const rest = allCodes
    .filter((c) => !seen.has(c))
    .sort((a, b) => (computedAt.get(a) ?? 0) - (computedAt.get(b) ?? 0));
  return [...touched, ...rest];
}

/**
 * Buckets that are never-computed or older than `staleMs` (for the alert).
 *
 * Judged from the same anchor as the due set (#3388): the alarm asks whether the
 * LANE has fallen behind, and its margin over the freshness window (#1248) only
 * holds when both are measured from one instant. A stamp moved back by a cached
 * read is at most one cache lifetime older than the start, and the alarm is not
 * the reader of data age.
 */
export function staleBuckets(
  known: KnownRow[],
  allCodes: string[],
  nowMs: number,
  staleMs: number,
): string[] {
  const computedAt = new Map(known.map((k) => [k.code, anchorMs(k)]));
  return allCodes.filter((c) => {
    const at = computedAt.get(c);
    return at === undefined || nowMs - at > staleMs;
  });
}

/**
 * Whether stale buckets should PAGE, given that a deliberate invalidation may be
 * draining (#1301).
 *
 * Saving a booking setting marks every bucket's slots stale on purpose, so the next
 * recompute rebuilds them over the new window. The stale alarm then sees the whole
 * roster past its threshold and pages about a condition the save itself created,
 * and the lane cannot drain 60+ buckets in the ~2 minutes between the freshness
 * window and the alarm. Nobody has seen it because no booking setting has ever been
 * saved in production; the first one pages.
 *
 * This is a BOUNDED grace, deliberately not a suppression. Staleness attributable
 * to a recent invalidation does not page, and the SAME staleness pages once the
 * grace expires, because a drain that has not finished by then is exactly the
 * fall-behind the alarm exists for. So the alarm keeps its meaning instead of
 * learning to ignore a class of real staleness (L36).
 *
 * Fails towards PAGING on anything it cannot trust: an unreadable marker (NaN, the
 * #1169 class, where every comparison is false) and a marker stamped in the future
 * both grant no grace. A wrong page costs a look; a wrongly withheld one costs the
 * booker serving stale availability with nothing saying so.
 */
/**
 * What the deliberate-invalidation marker read came back with (#1304).
 *
 * Three states, because the first two used to share `null` and they call for
 * opposite handling. ABSENT is the NORMAL state: nobody invalidated anything, so
 * staleness has nothing explaining it and pages at once. UNREADABLE means the
 * read itself failed, or the stored stamp could not be parsed, and one blip of
 * that is not worth waking anyone for.
 */
/**
 * How long a bucket's cached slots may age before this lane re-derives them.
 *
 * Real-time push and booking keep CHANGED buckets fresh in seconds; this lane
 * only covers the day-window slide and the missed-push backstop, so it does not
 * need to touch every bucket every minute. Recomputing all 60 every minute
 * saturated the lane at about 110 agents (#294).
 */
export const RECOMPUTE_FRESH_MS = 4 * 60_000;

/**
 * How much of the freshness window a bucket's deadline may be pulled EARLIER, to
 * spread the due set across ticks instead of letting it arrive in clumps (#1247).
 *
 * A FRACTION, not a duration, so the guarantee scales with whatever the window is
 * set to: a bucket is never recomputed within the remaining quarter of its window,
 * and is never held longer than the full window.
 *
 * 0.75 measured against the real shape (62 buckets, a 4 minute window, an
 * every-minute lane, all computed together): the worst tick falls from 62 to 21
 * and stays there, for about 7% more recomputes in total. Simulated over 30 ticks:
 *
 *   plain window     peak 62, steady peak 62, 434 recomputes
 *   this             peak 21, steady peak 21, 464 recomputes
 *
 * That is the right trade for a lane whose failure mode is a single tick exceeding
 * its budget rather than the total volume. Live timestamps showed 5, 6, 8, 15 then
 * 22 buckets refreshed in consecutive minutes instead of a steady 15, with the due
 * set at p50 7, p90 24, max 35.
 */
export const RECOMPUTE_JITTER_FRACTION = 0.75;

/**
 * Headroom between a bucket aging out and the staleness alarm firing (#1248).
 *
 * It must exceed one tick of the every-minute lane, or a bucket that has just
 * aged out is already alarming before the next cycle has had a chance to refresh
 * it, and the alarm would be reporting normal aging rather than a lane that
 * cannot keep up. Asserted in scripts/test-recompute-window-pair.ts rather than
 * left to this comment.
 */
export const STALE_ALARM_MARGIN_MS = 2 * 60_000;

/**
 * Alarm only if a bucket is STILL stale beyond this after a run, meaning the lane
 * genuinely cannot keep up (a wedged writer) rather than a bucket aging normally.
 *
 * DERIVED from the freshness window, not declared beside it (#1248). The two used
 * to sit two lines apart with nothing enforcing the gap, while the headroom
 * alert's own remediation advice was "widen the freshness window". Anyone
 * following that under pressure past 6 minutes started tripping this page
 * instead, so the advice manufactured a second alert while they were still
 * dealing with the first (L36: never embed remediation that can steer a
 * diagnosis wrong). Deriving it means widening the window moves the alarm with
 * it, and the advice stays true at any value.
 */
export const STALE_ALARM_MS = RECOMPUTE_FRESH_MS + STALE_ALARM_MARGIN_MS;

export type InvalidationMarker =
  | { state: "absent" }
  | { state: "unreadable" }
  | { state: "at"; atMs: number };

/**
 * How many CONSECUTIVE unreadable ticks before the staleness pages anyway.
 *
 * Dan (2026-08-05): "retry and page only after three consecutive failures".
 * #1301 chose to page on the first tick so the alarm never went quiet on a value
 * it could not check, which is the right instinct; what it lacked was the
 * difference between one database blip and a marker that has been unreadable for
 * three minutes running.
 */
export const INVALIDATION_UNREADABLE_TOLERANCE = 3;

/**
 * Window the consecutive-unreadable streak is counted over.
 *
 * It MUST outlast the ticks it has to span. The streak lives in a rate-limit
 * window, so a window shorter than the run of ticks would put three genuinely
 * consecutive failures in different windows, count the third as a first, and the
 * alarm would never fire while looking exactly like a marker that kept
 * recovering. The recompute lane is every minute, so three ticks span two
 * minutes; 300s leaves generous room for a late or dropped tick, and the margin
 * is asserted in scripts/test-precompute-cron.ts rather than left to this comment.
 */
export const INVALIDATION_UNREADABLE_WINDOW_S = 300;

export function staleBucketPage(
  staleCount: number,
  marker: InvalidationMarker,
  nowMs: number,
  graceMs: number,
  /**
   * Has the marker now been unreadable on `tolerance` CONSECUTIVE ticks?
   *
   * A boolean rather than a count, because that is exactly what the repo's streak
   * primitive answers (`recordConsecutiveStreak` returns whether the threshold was
   * reached). Asking for a count would mean a second read every minute on a lane
   * that shares its subrequest budget with three others, to say "4 ticks" instead
   * of "at least 3", which no reader acts on differently.
   */
  unreadableToleranceReached: boolean,
  tolerance: number = INVALIDATION_UNREADABLE_TOLERANCE,
): { page: boolean; reason: string } {
  if (staleCount === 0) return { page: false, reason: "nothing stale" };
  if (marker.state === "absent") {
    return { page: true, reason: "stale with no deliberate invalidation to explain it" };
  }
  if (marker.state === "unreadable") {
    // The tolerance applies HERE ONLY. An absent marker above is the normal state
    // and must never inherit this delay, or the alarm this whole lane exists for
    // would be three minutes late every time it mattered.
    if (!unreadableToleranceReached) {
      return {
        page: false,
        reason:
          "invalidation marker unreadable on this tick; waiting for " +
          `${tolerance} consecutive failures before paging`,
      };
    }
    return {
      page: true,
      reason:
        `invalidation marker could not be read on at least ${tolerance} consecutive ticks, ` +
        "so nothing can explain the staleness",
    };
  }
  const invalidatedAtMs = marker.atMs;
  const age = nowMs - invalidatedAtMs;
  if (age < 0) {
    return { page: true, reason: "invalidation marker is in the future, so it grants no grace" };
  }
  if (age >= graceMs) {
    return {
      page: true,
      reason: `deliberate invalidation ${Math.round(age / 60_000)}min ago has not drained within its grace`,
    };
  }
  return {
    page: false,
    reason: `deliberate invalidation ${Math.round(age / 1000)}s ago is still draining`,
  };
}

/**
 * Buckets the cron should recompute this run (#294): only those never-computed
 * or older than `freshMs`, oldest-first (never-computed sorts first). The cron
 * no longer force-recomputes every bucket every minute — real-time push/booking
 * keep changed buckets fresh; this lane just covers the day-window slide and the
 * missed-push backstop, so it only re-derives buckets aging past the freshness
 * window. Keeps work bounded and scalable.
 */
export function bucketsDueForRecompute(
  known: KnownRow[],
  allCodes: string[],
  nowMs: number,
  freshMs: number,
  jitterFraction: number = RECOMPUTE_JITTER_FRACTION,
): string[] {
  // From when each row's compute STARTED (#3388), not its stamp: a stamp moved back
  // past the bucket's grid point would bring it due again a tick later.
  const computedAt = new Map(known.map((k) => [k.code, anchorMs(k)]));
  return allCodes
    .filter((c) => {
      const at = computedAt.get(c);
      // A bucket with no row is showing NO availability until it is built, so it
      // is due at once and there is no timestamp to jitter anyway.
      if (at === undefined) return true;
      return nowMs >= bucketDueAtMs(c, at, freshMs, jitterFraction);
    })
    .sort((a, b) => (computedAt.get(a) ?? 0) - (computedAt.get(b) ?? 0));
}

/**
 * This bucket's PHASE within the freshness window, from a stable hash of its code.
 *
 * Stable, because a phase that moved per tick would reshuffle the rotation instead
 * of levelling it. Same FNV-1a trick `syncEligible` already uses to spread
 * calendar retries across minutes; collisions are harmless, they just mean two
 * buckets share a deadline.
 */
export function bucketPhaseMs(code: string, windowMs: number): number {
  if (windowMs <= 0) return 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % windowMs;
}

/**
 * When this bucket next falls due: the next point on ITS OWN phase-shifted grid
 * after it was last computed (#1247).
 *
 * A plain `age > freshMs` test makes every bucket refreshed in the same cycle fall
 * due in the same later cycle, so the due set arrives in clumps. Live timestamps
 * showed 5, 6, 8, 15 then 22 buckets in consecutive minutes rather than a steady
 * 15, with the due set at p50 7, p90 24, max 35, and that is what turns a per
 * bucket cost increase into a cycle that cannot drain within its budget.
 *
 * A grid rather than a shortened window, which matters for the cost. Simply
 * pulling deadlines earlier by a random offset spreads them, but it also shortens
 * the AVERAGE window and so does permanently more work. On a grid, a bucket
 * refreshed at its own grid point is next due exactly one window later, so the
 * steady-state age converges back to `freshMs` while the phases keep the ladder
 * spread. Only the first transition per bucket is short, and it is self
 * correcting.
 *
 * The gap is always in `(0, freshMs]`, so no bucket is ever held LONGER than the
 * plain window and the spreading cannot push anything closer to the staleness
 * alarm.
 */
export function bucketDueAtMs(
  code: string,
  computedAtMs: number,
  freshMs: number,
  jitterFraction: number = RECOMPUTE_JITTER_FRACTION,
): number {
  if (jitterFraction <= 0 || freshMs <= 0) return computedAtMs + freshMs;
  const phase = bucketPhaseMs(code, freshMs);
  const grid = Math.floor((computedAtMs - phase) / freshMs) + 1;
  const gridDueAt = phase + grid * freshMs;
  // FLOORED, so the #294 guarantee survives in a stated form. A grid point can
  // otherwise fall moments after a bucket was written, and recomputing a bucket
  // that fresh is exactly the waste #294 removed. The floor turns "never within
  // the window" into "never within the remaining quarter of it", which is a real
  // weakening, and is why it is a named fraction rather than a hidden offset.
  const floorAt = computedAtMs + freshMs * (1 - jitterFraction);
  return Math.max(gridDueAt, floorAt);
}

export interface RecomputeHeadroom {
  /** Run time as a percentage of the per-tick budget (for logs/observability). */
  utilizationPct: number;
  /** Whether the run recomputed every bucket that was due (didn't run out of budget). */
  drained: boolean;
  /**
   * True ONLY when the lane could not drain its due set within budget, i.e. it
   * is genuinely falling behind. A fully-drained cycle is keeping up and never
   * warns, no matter how much of the budget it used: a high-but-drained cycle
   * (e.g. a one-off post-deploy catch-up) is not actionable and alerting on it
   * is just noise. The route adds a consecutive-cycle streak on top so even a
   * single behind cycle stays quiet until it persists.
   */
  warn: boolean;
}

/**
 * Headroom for the recompute lane (#294 follow-up). `utilizationPct` is reported
 * for logs; `warn` fires only when the cycle failed to drain the due set within
 * budget. Pure so it's unit-tested; the route times the run and feeds it in.
 */
export function recomputeHeadroom(
  runMs: number,
  budgetMs: number,
  dueCount: number,
  recomputedCount: number,
): RecomputeHeadroom {
  const fraction = budgetMs > 0 ? runMs / budgetMs : 0;
  const drained = recomputedCount >= dueCount;
  return {
    utilizationPct: Math.round(fraction * 100),
    drained,
    warn: !drained,
  };
}

/**
 * Drain the due-bucket set in BOUNDED-CONCURRENCY waves within the time budget.
 * The recompute is DB-only (reads the busy_blocks cache + schedules, no live
 * Google), so several buckets recompute safely at once — which keeps the lane
 * draining the due set at fleet scale (#297) instead of the old one-at-a-time
 * loop that fell ~1 bucket behind per cycle once ~110 agents were live.
 *
 * Budget is checked BEFORE each wave (so it never overruns by more than one
 * wave), and a single bucket's failure is isolated (logged, not counted) rather
 * than aborting the whole cycle. Returns how many buckets were refreshed. Pure
 * (injected `recompute` + `withinBudget`) so it's unit-tested without IO.
 */
export async function recomputeDueBuckets<T = string>(
  due: T[],
  /**
   * Do one unit, and report HOW MANY things it refreshed. A unit stands for a
   * whole POOL of bucket codes on the lane (#2245), so the number is routinely
   * more than one; returning nothing means one, which is what every caller meant
   * before pooling.
   */
  recompute: (unit: T) => Promise<number | void>,
  withinBudget: () => boolean,
  concurrency: number,
  /** How to name a unit in the failure log. A unit is a POOL of bucket codes on
   *  the lane (#2245) and a single code elsewhere, so the caller says. */
  describe: (unit: T) => string = (u) => String(u),
): Promise<number> {
  // SUMMED HERE, deliberately, rather than by the caller.
  //
  // A caller accumulating this itself writes `total += await doOne(unit)`, and
  // that reads `total` BEFORE it awaits: with a wave of units in flight at once
  // they each add to the value they saw at the start, and the last one to settle
  // overwrites the rest. It shipped on 2026-09-11 and reported ONE pool's writes
  // as the whole cycle, so the lane judged itself behind on every tick and was
  // five cycles from a page about a fall behind that was not happening. The
  // concurrency lives in here, so the accumulation does too.
  let refreshed = 0;
  for (let i = 0; i < due.length; i += concurrency) {
    if (!withinBudget()) break;
    const wave = due.slice(i, i + concurrency);
    const results = await Promise.allSettled(wave.map((unit) => recompute(unit)));
    results.forEach((r, j) => {
      if (r.status === "fulfilled") {
        refreshed += typeof r.value === "number" ? r.value : 1;
      } else {
        log.error("precompute", { msg: "recompute failed", bucket: describe(wave[j]!) }, r.reason);
      }
    });
  }
  return refreshed;
}
