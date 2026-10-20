/**
 * The booking load run's bar: confirmed bookings a minute the run must sustain (#3124).
 *
 * ONE number, so the run and the alert that says when to raise it cannot disagree.
 * Dan raised it from 60 to 70 on 2026-10-20, ten times over the whole traffic peak of
 * 7 a minute measured that day (cal.com's routed responses plus Slate's routed
 * bookings, added minute by minute; the reading is on #3124).
 *
 * Today the load run's own judge still holds its 60 in `scripts/loadtest/book-plan.ts`
 * (four drivers at fifteen a minute). Pointing the judge at this constant is the bar
 * change still to do under #3124, together with a passing load run at 70; until then
 * this is what the daily busy minute check (`src/lib/monitor/busy-minutes.ts`) judges
 * against, because 70 is the bar Dan set.
 *
 * Pure and import free, so the load test scripts can read it on bare node.
 */
export const LOAD_RUN_BOOKINGS_PER_MINUTE = 70;

/**
 * The smallest whole count of bookings in one minute that is MORE than a tenth of
 * `barPerMinute`: 8 at a bar of 70, 7 at 60, 7 at 65. A minute at exactly a tenth (7
 * at 70) leaves the bar ten times over it, which is the premise holding, so it does
 * not count.
 *
 * Derived rather than written beside the bar, so raising the bar moves the alert with
 * it and there is no second number to update. A bar that is not a positive whole
 * number throws: a threshold made from it would be a number nobody chose.
 */
export function busyMinuteThreshold(barPerMinute: number): number {
  if (!Number.isInteger(barPerMinute) || barPerMinute <= 0) {
    throw new Error(`the load run's bar must be a positive whole number of bookings a minute, got ${barPerMinute}`);
  }
  return Math.floor(barPerMinute / 10) + 1;
}
