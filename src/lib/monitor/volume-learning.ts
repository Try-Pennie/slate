/**
 * Phase 2 of #1956: re-fitting the low volume floors from Slate's OWN bookings once
 * Slate carries the traffic.
 *
 * WIRED, AND INERT UNTIL A PERSON DECLARES THE RAMP OVER (#2739). An admin sets
 * the ramp end on /admin/alerts; until then `volume-relearn.ts` reads nothing, and
 * the monitor judges against the cal.com measurement (`volume-baseline.ts`). Once
 * it is set, the monitor lane refits from Slate's own bookings once a day and
 * stores the result, and the fixtures in scripts/test-volume-learning.ts say what
 * a refit does.
 *
 * Three traps each turn a self learning floor into an alarm that can never fire,
 * and each has its own guard here:
 *
 * - THE RAMP IS NORMAL TO NOBODY. During the ramp Slate deliberately carries a
 *   fraction of traffic, and floors learned then are far too low once it carries
 *   all of it. So learning refuses to start without an EXPLICIT ramp end, and every
 *   booking before it is excluded and counted, rather than the window merely
 *   happening to start later.
 * - TEST BOOKINGS ARE NOT TRAFFIC. The smoke agents and buckets write real rows,
 *   and counting them inflates the floors by exactly the traffic that is not real.
 * - A FLOOR THAT FOLLOWS VOLUME CANNOT SEE A SLOW DECLINE. Two guards: a recent
 *   window running well below the longer horizon is reported as a decline and NOT
 *   learned from, and no learned floor may fall below the measured anchor (the
 *   cal.com fit), so a decline too gradual for the comparison still meets a floor
 *   under the floor.
 */
import {
  SERIES_BUCKET_MINUTES,
  fitFloorCells,
  type BookingSeries,
  type FloorCell,
  type VolumeBaseline,
} from "./volume-floors.ts";

const WEEK_MS = 7 * 24 * 60 * 60_000;

export const LEARNING = {
  /** Whole weeks of post ramp traffic before anything is learned. */
  minWeeks: 4,
  /** How far back learning reads. */
  horizonWeeks: 8,
  /** The recent window compared against the rest of the horizon. */
  recentWeeks: 2,
  /** Below this share of the longer horizon's weekly rate, the recent weeks are a decline. */
  declineRatio: 0.8,
} as const;

export interface SlateBookingRow {
  createdAtMs: number;
  /** True for a booking on a test bucket, which is never traffic. */
  isTest: boolean;
}

export type LearnedFloors =
  | { status: "not-started"; reason: "ramp-not-declared" }
  | { status: "insufficient"; weeksSinceRamp: number; needWeeks: number; excludedTest: number; excludedRamp: number }
  | {
      status: "declining";
      recentPerWeek: number;
      earlierPerWeek: number;
      /** Fitted on the earlier weeks only, so the decline is not learned as normal. */
      baseline: VolumeBaseline;
      excludedTest: number;
      excludedRamp: number;
    }
  | { status: "learned"; baseline: VolumeBaseline; excludedTest: number; excludedRamp: number };

function seriesOf(bookings: number[], startMs: number, endMs: number): BookingSeries {
  const per = SERIES_BUCKET_MINUTES * 60_000;
  const n = Math.max(0, Math.floor((endMs - startMs) / per));
  const counts = new Array<number>(n).fill(0);
  for (const ms of bookings) {
    const i = Math.floor((ms - startMs) / per);
    if (i >= 0 && i < n) counts[i]! += 1;
  }
  return { startMs, bucketMinutes: SERIES_BUCKET_MINUTES, counts };
}

/** Every learned floor held at or above the anchor's, cell by cell. */
export function underpin(learned: FloorCell[][], anchor: FloorCell[][]): FloorCell[][] {
  return learned.map((day, d) =>
    day.map((cell, h) => ({
      floor30: Math.max(cell.floor30, anchor[d]?.[h]?.floor30 ?? 0),
      floor120: Math.max(cell.floor120, anchor[d]?.[h]?.floor120 ?? 0),
      typical120: cell.typical120,
    })),
  );
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function learnFloors(input: {
  bookings: SlateBookingRow[];
  /** When the ramp ended, declared by a person. Null means it has not. */
  rampEndMs: number | null;
  nowMs: number;
  /** The measured floors learning may never fall below. */
  anchor: VolumeBaseline;
}): LearnedFloors {
  if (input.rampEndMs === null) return { status: "not-started", reason: "ramp-not-declared" };
  const per = SERIES_BUCKET_MINUTES * 60_000;
  const endMs = Math.floor(input.nowMs / per) * per;
  const startMs = Math.ceil(Math.max(input.rampEndMs, endMs - LEARNING.horizonWeeks * WEEK_MS) / per) * per;

  let excludedTest = 0;
  let excludedRamp = 0;
  const real: number[] = [];
  for (const b of input.bookings) {
    if (b.isTest) {
      excludedTest++;
      continue;
    }
    if (b.createdAtMs < input.rampEndMs) {
      excludedRamp++;
      continue;
    }
    real.push(b.createdAtMs);
  }

  const weeks = Math.floor((endMs - startMs) / WEEK_MS);
  if (weeks < LEARNING.minWeeks) {
    return { status: "insufficient", weeksSinceRamp: Math.max(0, weeks), needWeeks: LEARNING.minWeeks, excludedTest, excludedRamp };
  }

  const baselineFrom = (series: BookingSeries, fromMs: number, toMs: number): VolumeBaseline => {
    const bookings = series.counts.reduce((s, n) => s + n, 0);
    return {
      source: "slate",
      measuredOn: isoDate(endMs),
      fromDate: isoDate(fromMs),
      toDate: isoDate(toMs - 1),
      zone: input.anchor.zone,
      scope: "Every real customer booking Slate took after the ramp ended",
      tierShare: null,
      bookings,
      cells: underpin(fitFloorCells(series, input.anchor.zone), input.anchor.cells),
    };
  };

  // The comparison is on whole weeks, so a weekday's shape cancels out of it.
  const splitMs = endMs - LEARNING.recentWeeks * WEEK_MS;
  const inRange = (from: number, to: number) => real.filter((ms) => ms >= from && ms < to).length;
  const recentPerWeek = inRange(splitMs, endMs) / LEARNING.recentWeeks;
  const earlierWeeks = (splitMs - startMs) / WEEK_MS;
  const earlierPerWeek = inRange(startMs, splitMs) / earlierWeeks;
  if (earlierPerWeek > 0 && recentPerWeek < LEARNING.declineRatio * earlierPerWeek) {
    return {
      status: "declining",
      recentPerWeek,
      earlierPerWeek,
      baseline: baselineFrom(seriesOf(real, startMs, splitMs), startMs, splitMs),
      excludedTest,
      excludedRamp,
    };
  }
  return { status: "learned", baseline: baselineFrom(seriesOf(real, startMs, endMs), startMs, endMs), excludedTest, excludedRamp };
}
