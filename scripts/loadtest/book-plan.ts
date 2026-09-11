/**
 * The decisions a booking load run makes, separated from the driving of it
 * (#2243), so every one of them is testable with no network and no clock.
 *
 * The pacing is DERIVED from the shipped rate limit constants rather than copied
 * as numbers. Two copies of a ceiling drift, and the drift is silent in the worst
 * direction: the run would spend its time being refused by a limit it thought it
 * was under, and the report would read as Slate failing rather than as the driver
 * exceeding a ceiling somebody had changed (L41).
 */
import {
  AVAILABILITY_LIMITER,
  BOOKING_API_IP_LIMITER,
} from "../../src/lib/rate-limit-core.ts";
import { codeSequence, MEASURED_CODE_MIX, type CodeWeight } from "./code-mix.ts";

/** Availability reads a single address may make in a minute (30, from the app). */
export const AVAILABILITY_PER_MINUTE = AVAILABILITY_LIMITER.perMinute;
/** Booking API writes a single address may make in a minute (60, from the app). */
export const BOOKING_WRITES_PER_MINUTE = BOOKING_API_IP_LIMITER.perMinute;

/**
 * The run's own target: four drivers at fifteen a minute for ten minutes.
 *
 * Fifteen times four is SIXTY, which is exactly the per address write ceiling, and
 * that is the point rather than an accident. The run is meant to sit on the
 * ceiling so the judge can attribute the 429s it produces (#2244); aiming under it
 * would leave the limiter unexercised and aiming far over it would make the whole
 * run a measurement of the limiter instead of of the booking path.
 */
export const DRIVERS = 4;
export const PER_DRIVER_PER_MINUTE = 15;
export const RUN_MINUTES = 10;

/** One request the driver will make. */
export interface PlannedRequest {
  /** 0-based, unique within the driver. */
  n: number;
  /** When to fire it, epoch ms. */
  atMs: number;
  code: string;
}

/**
 * Evenly spaced rather than fired in bursts at the top of each minute.
 *
 * A per-minute limiter counts a window, so sixty requests in the first second of a
 * minute are inside the ceiling and sixty spread across it are too. They are not
 * the same test: the bunched version measures how the app handles a thundering
 * herd once a minute, which is the burst's job and is measured separately with a
 * control. The steady version is the one that says whether the path holds up at a
 * rate, which is what the rest of the run is for.
 */
export function requestSchedule(opts: {
  total: number;
  perMinute: number;
  startAtMs: number;
  mix?: readonly CodeWeight[];
}): PlannedRequest[] {
  if (opts.total <= 0 || opts.perMinute <= 0) return [];
  const gapMs = 60_000 / opts.perMinute;
  const codes = codeSequence(opts.total, opts.mix ?? MEASURED_CODE_MIX);
  // A mix that yields no codes yields no plan, rather than a plan of `undefined`
  // codes every request would send as the string "undefined" and every response
  // would refuse for a reason nobody could read.
  if (codes.length < opts.total) return [];
  return Array.from({ length: opts.total }, (_, n) => ({
    n,
    atMs: Math.round(opts.startAtMs + n * gapMs),
    code: codes[n]!,
  }));
}

/**
 * How often ONE driver may refresh its availability view, given how many drivers
 * share the address.
 *
 * The availability ceiling is per ADDRESS, and a CI job's drivers all come from
 * one, so the budget is divided rather than held by each. The safety fraction
 * leaves room for the retry the run makes when a read fails: spending the whole
 * budget on first attempts means the first failure is the start of a 429 cascade,
 * and the run would then be measuring its own pacing.
 */
export function availabilityRefreshMs(
  drivers: number = DRIVERS,
  perMinute: number = AVAILABILITY_PER_MINUTE,
  safetyFraction = 0.8,
): number {
  const share = (perMinute * safetyFraction) / Math.max(1, drivers);
  if (share <= 0) return 60_000;
  return Math.ceil(60_000 / share);
}

/**
 * Whether a driver has arrived in time for the burst.
 *
 * The setup step picks ONE bucket and ONE slot and hands every driver the same
 * `START_AT`, because a burst whose drivers each chose their own slot is not a
 * burst: nothing contends and every request succeeds. A driver that wakes up after
 * the moment has passed must EXIT rather than fire late, because a late request
 * meets an already-taken slot and records a SLOT_TAKEN that looks exactly like the
 * contention the control is counting (L11). Reporting `missed` is what keeps the
 * judge's "exactly one 200" honest: it can refuse to judge a burst that was not
 * actually simultaneous, instead of judging a staggered one.
 */
export type BurstReadiness = "ready" | "early" | "missed";

export function burstReadiness(opts: {
  startAtMs: number;
  nowMs: number;
  /** How far past the moment still counts as being part of the burst. */
  graceMs: number;
}): BurstReadiness {
  const late = opts.nowMs - opts.startAtMs;
  if (late < 0) return "early";
  return late <= opts.graceMs ? "ready" : "missed";
}

/**
 * The lead id a request books under.
 *
 * It carries the run, the driver and the request number, so every row a run wrote
 * can be found afterwards and attributed, and so two drivers can never collide on
 * one id. `external_id` IS the Salesforce id to Slate, and the booker dedupes on
 * it, so a repeated id would be answered with the FIRST booking rather than a new
 * one and the run would silently stop creating anything.
 */
export function externalIdFor(runId: string, driver: number, n: number): string {
  return `${runId}-${driver}-${n}`;
}

/**
 * Which of the offered times to book.
 *
 * RANDOM, and this is the one place a load run is deliberately not deterministic.
 * Every other choice (the code, the fault, the order) is fixed so that a run that
 * passed and a run that failed differ by the code rather than by the dice. The
 * slot cannot be: four drivers each taking the first offered time would contend on
 * one slot all run, which measures the unique index over and over and never
 * measures the booking path at a rate. The randomness is injected so the choosing
 * itself is still testable.
 */
export function pickSlot<T>(slots: readonly T[], rand: () => number = Math.random): T | null {
  if (slots.length === 0) return null;
  const i = Math.floor(rand() * slots.length);
  // A generator that returns exactly 1 (or anything out of range) would index past
  // the end and yield undefined, which every caller would then send as a missing
  // start and every response would refuse as a validation error.
  return slots[Math.min(slots.length - 1, Math.max(0, i))] ?? null;
}

/** One recorded response. The judge (#2244) reads these and nothing else. */
export interface BookingAttempt {
  driver: number;
  n: number;
  code: string;
  externalId: string;
  /** When the request was sent, epoch ms. */
  sentAtMs: number;
  /** Wall time of the request in ms, measured around the fetch. */
  wallMs: number;
  /** The HTTP status, or 0 when the request never got a reply at all. */
  status: number;
  /** Slate's own outcome (`booked`, `rescheduled`), or its error code. */
  outcome: string | null;
  /** The slot asked for, so a conflict can be traced to the slot it contended on. */
  startIso: string | null;
  /**
   * The address Slate saw, echoed back on the LOADTEST path only.
   *
   * Attributing a write 429 needs the address the CEILING was applied to, not the
   * one the runner believes it has: a CI runner behind egress NAT shares an address
   * with everything else on it, and a run that assumed otherwise would report the
   * limiter refusing it when something else spent the budget (#2244).
   */
  seenIp: string | null;
}

/** What one driver writes when it finishes. The judge refuses without all of them. */
export interface DriverResult {
  runId: string;
  driver: number;
  mode: "steady" | "burst";
  /** How many requests the plan held, so a short file is visible as short. */
  planned: number;
  startedAtMs: number;
  finishedAtMs: number;
  /** Set only in burst mode, and only when the driver did not fire. */
  burstSkipped?: BurstReadiness;
  attempts: BookingAttempt[];
}
