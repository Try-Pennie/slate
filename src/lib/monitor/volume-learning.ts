/**
 * Phase 2 of #1956: re-fitting the low volume floors from Slate's OWN bookings once
 * Slate carries the traffic.
 *
 * WIRED PER DEBT TIER, AND STARTED BY EACH TIER'S FIRST REAL BOOKING (#2739,
 * #2874). `volume-relearn.ts` refits once a day, each carried tier from its own
 * bookings after its ramp start: the tier's first real booking, or a later ramp end
 * an admin declares on /admin/alerts. Until a tier is learned, Low is judged against
 * the cal.com measurement (`volume-baseline.ts`) and any other tier is not judged.
 * The fixtures in scripts/test-volume-learning.ts say what a refit does.
 *
 * Three traps each turn a self learning floor into an alarm that can never fire,
 * and each has its own guard here:
 *
 * - THE RAMP IS NORMAL TO NOBODY. During the ramp Slate deliberately carries a
 *   fraction of traffic, and floors learned then are far too low once it carries
 *   all of it. So learning refuses to start without an explicit ramp START (a
 *   tier's first real booking, or a later declared ramp end, #2874), and every
 *   booking before it is excluded and counted, rather than the window merely
 *   happening to start later. For Low the cal.com anchor keeps a floor learned on a
 *   partial ramp from judging below the measurement; a tier with no anchor learns a
 *   low floor until the horizon moves past its partial weeks, which a declared ramp
 *   end avoids.
 * - TEST BOOKINGS ARE NOT TRAFFIC. The smoke agents and buckets write real rows,
 *   and counting them inflates the floors by exactly the traffic that is not real.
 * - A FLOOR THAT FOLLOWS VOLUME CANNOT SEE A SLOW DECLINE. Two guards: a recent
 *   window running well below the longer horizon is reported as a decline and NOT
 *   learned from, and no learned floor may fall below the measured anchor (the
 *   cal.com fit), so a decline too gradual for the comparison still meets a floor
 *   under the floor.
 *
 * And a day the org records as CLOSED (#2764) is not traffic in either direction:
 * it is left out of the fit, and the decline comparison is made per OPEN day, so a
 * shut Christmas week inside the recent weeks is not read as bookings falling away.
 */
import { DateTime } from "luxon";
import {
  SERIES_BUCKET_MINUTES,
  fitFloorCells,
  type BookingSeries,
  type ClosedDates,
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
  /** True for a booking on a test bucket, or one made from a development host on a
   *  real bucket (#2974, `isTestSourceBooking`), which is never traffic. */
  isTest: boolean;
  /**
   * The debt tier of the bucket that took it (#2874), or null for a bucket whose
   * code is not an XBC (the test buckets). The refit learns each tier from its own
   * rows; a fixture that learns one population may leave it out.
   */
  tier?: string | null;
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
  /**
   * When learning may start: the tier's ramp start (#2874, its first real booking
   * or a later declared ramp end). Null means it has not started.
   */
  rampEndMs: number | null;
  nowMs: number;
  /**
   * The measured floors learning may never fall below, or null for a tier nobody
   * has measured (#2874), which then learns from its own traffic with nothing under
   * it and must say so wherever its floors are shown.
   */
  anchor: VolumeBaseline | null;
  /** The zone weekday and hour are judged in. Defaults to the anchor's; required without one. */
  zone?: string;
  /** Whose traffic the floors describe, in plain words. */
  scope?: string;
  /** The dates the org records as closed, from `business_hours_exceptions` (#2764). */
  closedDates: ClosedDates;
}): LearnedFloors {
  const zone = input.zone ?? input.anchor?.zone;
  // A fit with no zone would judge weekday and hour in whatever the runtime's is,
  // which is UTC on a Worker: refuse rather than fit the week to the wrong clock.
  if (!zone) throw new Error("volume learning: no zone to judge weekday and hour in");
  if (input.rampEndMs === null) return { status: "not-started", reason: "ramp-not-declared" };
  const per = SERIES_BUCKET_MINUTES * 60_000;
  const endMs = Math.floor(input.nowMs / per) * per;
  const startMs = Math.ceil(Math.max(input.rampEndMs, endMs - LEARNING.horizonWeeks * WEEK_MS) / per) * per;

  const closed = new Set(input.closedDates);
  const onClosedDay = (ms: number) => closed.has(DateTime.fromMillis(ms, { zone }).toISODate() ?? "");

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
    // A lead booking ahead on a day the office is shut is not that day's traffic,
    // and the day is not sampled by the fit, so it is simply not counted.
    if (onClosedDay(b.createdAtMs)) continue;
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
      zone,
      scope: input.scope ?? "Every real customer booking a landing page sent Slate after the ramp ended",
      tierShare: null,
      bookings,
      cells: input.anchor
        ? underpin(fitFloorCells(series, zone, input.closedDates), input.anchor.cells)
        : fitFloorCells(series, zone, input.closedDates),
    };
  };

  // The comparison is on whole weeks, so a weekday's shape cancels out of it, and
  // per OPEN time within them, so a closed day on one side is not a decline.
  const splitMs = endMs - LEARNING.recentWeeks * WEEK_MS;
  const inRange = (from: number, to: number) => real.filter((ms) => ms >= from && ms < to).length;
  const openMs = (from: number, to: number) => {
    let shut = 0;
    for (const d of closed) {
      const dayStart = DateTime.fromISO(d, { zone }).startOf("day");
      if (!dayStart.isValid) continue;
      const a = Math.max(from, dayStart.toMillis());
      const b = Math.min(to, dayStart.plus({ days: 1 }).toMillis());
      if (b > a) shut += b - a;
    }
    return to - from - shut;
  };
  const perWeek = (from: number, to: number) => {
    const open = openMs(from, to);
    return open > 0 ? (inRange(from, to) / open) * WEEK_MS : 0;
  };
  const recentPerWeek = perWeek(splitMs, endMs);
  const earlierPerWeek = perWeek(startMs, splitMs);
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
