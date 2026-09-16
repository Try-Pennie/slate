import type { RateThresholds } from "./booking-failure-rate.ts";

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
 * ## The numbers are MEASURED now (#2484)
 *
 * They shipped as a starting point: 20 attempts in a rolling hour, chosen when
 * Slate had taken no real customer booking and every attempt on record was the
 * canary's. #1367 was to arm the check once somebody had read a real cycle, and
 * arming it at those numbers would have been silent in the way that reads as
 * healthy, because the floor was never reachable by the traffic it judges.
 *
 * Measured against cal.com's routing form responses on 2026-09-16, 27,122 real
 * leads over 14 days (`pnpm measure:lead-hours` reproduces it):
 *
 * | what                        | Low leads an hour        | hours reaching 20 |
 * |---|---|---|
 * | the whole Low tier          | median 29, p25 17        | 69 percent        |
 * | the biggest single page     | median 18, p25 10        | 44 percent        |
 * | the two quieter pages       | median 7 and 5           | 4 and 3 percent   |
 *
 * **The pilot flips ONE page**, so the tier's own volume overstates what reaches
 * Slate on flip morning, and a floor fitted to the tier is one no single page can
 * clear. At 20 in an hour the check would have reported `insufficient` on most
 * ticks of flip day.
 *
 * ## Why a four hour window and a floor of ten
 *
 * The window rolls, so the check judges as soon as the floor has ACCUMULATED
 * rather than when the window ends: ten Low attempts arrive on the pilot page in
 * roughly 35 minutes, and all three pages reach the floor inside one window at
 * their measured medians. The four hours are what keeps the DENOMINATOR worth
 * dividing by (about 72 attempts on the pilot page), because the alternative
 * considered, a floor of 5 in one hour, makes two failed bookings in a quiet hour
 * a 40 percent share and a page (L139: a floor low enough to be reachable is also
 * low enough for saturation and noise to look alike).
 *
 * Ten rather than five also keeps one failure from carrying the share on its own:
 * at the floor it takes three.
 *
 * Re-measure as the flip widens. The floors are cheap to move and the measurement
 * is a command rather than an afternoon.
 */
export const SHIPPED_FAILURE_RATE_THRESHOLDS: RateThresholds = {
  windowMs: 4 * 60 * 60_000,
  minAttempts: 10,
  failPct: 20,
};
