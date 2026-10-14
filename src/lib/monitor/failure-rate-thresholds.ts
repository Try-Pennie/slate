import type { RateThresholds, RecentThresholds } from "./booking-failure-rate.ts";

/**
 * When a wave of refused bookings is a page rather than ordinary contention.
 *
 * It lives here rather than inline in the monitor route so the offline suite can
 * assert the SHIPPED numbers rather than a copy of them (L63): a test that
 * restates the thresholds passes just as happily while the route carries
 * something else.
 *
 * `failPct` must be EXCEEDED, not merely met. `minAttempts` is what stops a quiet
 * window where 1 of 1 attempts failed from paging.
 *
 * ## The numbers are DERIVED from measured traffic (#2484, #2494)
 *
 * #2484 fitted them by hand to ONE landing page, the first flip: 10 attempts in a
 * rolling four hours. Since 2026-10-01 15:46 UTC the split sends half of every
 * tier on every page to Slate. At that share the measurement below puts 31
 * attempts in 85 percent of four hour windows and 22 in 85 percent of three hour
 * ones, so a floor of ten in four hours was both slower than it needed to be and
 * let one bad booking move the share ten points.
 *
 * So the pair is now the output of `deriveFailureRateThresholds` over
 * `MEASURED_ATTEMPT_TRAFFIC`, and nothing in it is typed by hand except the
 * policy in `FAILURE_RATE_FIT` and Slate's share of the split:
 *
 * - **The floor** is the smallest attempt count at which a page takes
 *   `failuresToBreachAtFloor` failed bookings. Five at 20 percent gives 20: one
 *   bad booking moves the share five points, a quarter of the threshold, where at
 *   ten it took three failures and moved it ten (L139).
 * - **The window** is the shortest whole number of hours in which Slate's share of
 *   the measured traffic reaches that floor in `windowCoverage` of all rolling
 *   windows, nights and weekends included. A shorter window is a faster page: a
 *   total outage has to outweigh the successes already in the window, so a
 *   window holding half as many successes is crossed in half the time.
 *
 * ## The measurement
 *
 * `MEASURED_ATTEMPT_TRAFFIC` is every booking cal.com took in Low, Medium, High
 * and Very High over the span all four committed measurements cover (the same
 * fixtures the volume floors are fitted to, scripts/fixtures/calcom-*-bookings.json),
 * summed bucket by bucket and slid across in windows of one to four hours.
 * `scripts/test-failure-rate-fit.ts` re-derives it from those files and fails when
 * it differs, so it cannot be edited away from the traffic (L107, L422).
 *
 * Ultra High is left out because cal.com's measurement of it is too thin to be
 * committed (3,404 bookings in nine weeks, re-measured 2026-10-01 for #2888 and
 * refused as fitting no floor). It is about seven percent of the traffic, so
 * leaving it out UNDERSTATES what the check sees. Both effects of that run one way:
 * the derivation can pick a window LONGER than the real traffic needs (a slower
 * page), never a shorter one, and the real traffic reaches the floor in at least
 * the measured 85 percent of windows. The cost is speed, not blindness.
 *
 * The measurement predates the split, so it is cal.com's WHOLE traffic, and the
 * split is applied as `slateShare`. Re-measuring after 2026-10-01 15:46 UTC would
 * count cal.com's half only; pin `MEASURE_END` before it (`pnpm measure:volume-floors`).
 *
 * ## When the share moves
 *
 * Change `slateShare` and the test re-derives the pair. A smaller share lengthens
 * the window; a share so small that no four hour window reaches the floor is
 * refused at derivation rather than shipped as a check that only ever says
 * `insufficient`, which renders exactly like healthy (L98). Going back to fewer
 * pages without changing it leaves the check `insufficient` more often, which the
 * failing bookings verdict watch (#2936) reports as a blind detector.
 */
export const FAILURE_RATE_FIT = {
  /** The share of attempts that must FAIL before a page, exceeded rather than met. */
  failPct: 20,
  /** How many failed bookings a page takes at the floor. */
  failuresToBreachAtFloor: 5,
  /** The share of rolling windows, around the clock, in which the floor must be reachable. */
  windowCoverage: 0.85,
  /** The longest window considered, and the one #2484 shipped at. */
  maxWindowHours: 4,
} as const;

export type FailureRateFit = {
  failPct: number;
  failuresToBreachAtFloor: number;
  windowCoverage: number;
  maxWindowHours: number;
};

/** What cal.com's bookings say about the traffic the check judges. */
export interface AttemptTrafficMeasurement {
  source: "calcom";
  /** The debt tiers counted. */
  tiers: string[];
  /** The newest of the measurements it was read from. */
  measuredOn: string;
  /** The span every measurement covers, as instants. */
  from: string;
  to: string;
  /** Every booking counted over that span. */
  bookings: number;
  /** The share of rolling windows `windowReach` is reached by. */
  coverage: number;
  /** Hours of window, as a string, to the WHOLE count `coverage` of such windows reach. */
  windowReach: Record<string, number>;
  /** Tiers left out, each with its reason. */
  excluded: Record<string, string>;
  /** Slate's share of every tier, applied to the whole count. */
  slateShare: number;
  /** Where the share comes from. */
  slateShareSource: string;
}

export const MEASURED_ATTEMPT_TRAFFIC: AttemptTrafficMeasurement = {
  source: "calcom",
  tiers: ["1", "2", "3", "4"],
  measuredOn: "2026-09-29",
  from: "2026-07-28T16:30:00.000Z",
  to: "2026-09-25T13:55:00.000Z",
  bookings: 45738,
  coverage: 0.85,
  windowReach: { "1": 13, "2": 28, "3": 44, "4": 63 },
  excluded: {
    "5": "too thin for cal.com's measurement to be committed (#2888); about 7 percent of bookings, so leaving it out understates the traffic",
  },
  slateShare: 0.5,
  slateShareSource: "trypennie's split, half of every tier on every page since 2026-10-01 15:46 UTC",
};

/**
 * How many failed bookings out of `attempts` it takes for the share to EXCEED
 * `failPct`, the comparison `judgeFailureRate` makes: the quantity the floor guards.
 */
export function failuresToBreach(attempts: number, failPct: number): number {
  return Math.floor((attempts * failPct) / 100) + 1;
}

/** The smallest attempt count at which a page takes `failuresToBreachAtFloor` failures. */
export function minAttemptsFor(fit: FailureRateFit): number {
  for (let n = 1; ; n++) {
    if (failuresToBreach(n, fit.failPct) >= fit.failuresToBreachAtFloor) return n;
  }
}

/**
 * The thresholds the measurement and the policy give. Throws, by name, on a share
 * it cannot read and on traffic that no window up to `maxWindowHours` can bring to
 * the floor: either would otherwise ship a check that can never conclude.
 */
export function deriveFailureRateThresholds(m: AttemptTrafficMeasurement, fit: FailureRateFit): RateThresholds {
  if (!Number.isFinite(m.slateShare) || m.slateShare <= 0 || m.slateShare > 1) {
    throw new Error(`failure rate fit: Slate's share must be above 0 and at most 1, not ${m.slateShare}`);
  }
  const minAttempts = minAttemptsFor(fit);
  for (let hours = 1; hours <= fit.maxWindowHours; hours++) {
    const whole = m.windowReach[String(hours)];
    if (typeof whole === "number" && Math.floor(whole * m.slateShare) >= minAttempts) {
      return { windowMs: hours * 60 * 60_000, minAttempts, failPct: fit.failPct };
    }
  }
  throw new Error(
    `failure rate fit: no window up to ${fit.maxWindowHours} hours reaches ${minAttempts} attempts at a share of ${m.slateShare}`,
  );
}

export const SHIPPED_FAILURE_RATE_THRESHOLDS: RateThresholds = deriveFailureRateThresholds(
  MEASURED_ATTEMPT_TRAFFIC,
  FAILURE_RATE_FIT,
);

/**
 * The recent sub window the booking failure page stands down on (#3275): whether
 * failures are still happening, and whether they have measurably stopped.
 *
 * The three hour window above decides whether there was a wave. It cannot say when a
 * wave ended, because its share moves in both directions as old samples age out with
 * nothing new happening. On 2026-10-14 it paged at 6:00am on 8 of 38 (21%), an hour
 * after the last failure, then said "completing again" at 6:05am on 7 of 39 (18%)
 * because a 3:02am failure aged out. On 2026-10-04 it paged and all-cleared in the
 * same minute at 9:01pm with no new refusal. These three numbers are what the page now
 * stands down on instead.
 *
 * - **30 minutes.** Long enough to hold a clean run on ordinary traffic, short enough
 *   that "nothing has failed in the last half hour" still means the wave is over
 *   rather than that it is old news. Measured with the same fixtures and the same
 *   half share as the window above (`scripts/test-failure-rate-fit.ts` re-derives
 *   it): between 9am and 8pm ET, 96% of 30 minute windows hold at least 5 attempts;
 *   around the clock, 74%. A 15 minute window holds 5 in only 52% of daytime windows,
 *   so the all-clear would wait on traffic most of the day; 60 minutes would keep a
 *   page open for an hour after the last failure.
 * - **At least 5 attempts.** The same count `FAILURE_RATE_FIT` sets as the failures a
 *   page takes at the floor. Fewer is a quiet half hour that measured nothing, and
 *   it says nothing either way (L98, L695). Five clean attempts in a row would happen
 *   by chance about 33% of the time under a failure rate sitting exactly on the 20%
 *   line, 17% at 30% and 5% at 46% (the 2026-08-06 wave), so a wave well over the
 *   line rarely stands down on luck; one sitting on the line can, and its next
 *   failure pages again, which is a measured fact and not an old one.
 * - **At most 5% failing.** A quarter of `failPct`. Zero failures until a clean run
 *   reaches 20 attempts, then one: an ordinary race at a busy hour does not hold a
 *   page open, and the gap between 5% to stand down and 20% to page is the
 *   hysteresis that stops a share sitting near the line from paging and clearing in
 *   turn.
 *
 * Re-measure alongside the window when Slate's share of the split moves.
 */
export const SHIPPED_FAILURE_RATE_RECENT: RecentThresholds = {
  windowMs: 30 * 60_000,
  minAttempts: FAILURE_RATE_FIT.failuresToBreachAtFloor,
  recoverPct: FAILURE_RATE_FIT.failPct / 4,
};

/**
 * When a wave of reminder emails that did not go out is a page rather than one
 * lead's bad address (#2496).
 *
 * `booking_reminder_failed:<id>` fires per booking, so a single refused recipient
 * is one message and every reminder in the roster failing is one per lead, none of
 * which says how many share a cause. The two send different people to do different things,
 * so the lane measures a SHARE as well, in the same shape as the booking failure
 * rate above and judged by the same `judgeFailureRate`.
 *
 * ## Why these numbers, and why they no longer match the pair above
 *
 * They were fitted with the booking pair to #2484's one page measurement. #2494
 * refitted the booking pair to the split's traffic and deliberately left these:
 * reminders are sent on the reminder schedule rather than when leads arrive, so the
 * booking arrival measurement says nothing about how many reminders fall in a
 * window, and moving this pair on it would be fitting to a proxy (L63). They stay
 * on the argument below until reminder sends are measured themselves. A reminder
 * wave is strictly SMALLER than the booking volume, since only a lead who books
 * gets one.
 *
 * On the pilot page #2484 measured a median of 18 Low leads an hour, so a four
 * hour window sees about 72 leads and some fraction of that in bookings. Ten
 * attempts is what that fraction can be relied on to reach inside one window while
 * still being large enough that one failure cannot carry the share: at the floor a
 * breach takes three failures, not one (L139, the floor low enough to be reachable
 * is also low enough for saturation and noise to look alike).
 *
 * A shorter window was rejected while the traffic was one page: on so little
 * volume it would only make the denominator smaller, and a denominator of five
 * turns two bad addresses into a 40 percent share.
 *
 * Re-measure from the reminder sends themselves before moving these.
 */
export const SHIPPED_REMINDER_FAILURE_RATE_THRESHOLDS: RateThresholds = {
  windowMs: 4 * 60 * 60_000,
  minAttempts: 10,
  failPct: 20,
};
