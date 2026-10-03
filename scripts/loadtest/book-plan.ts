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
/** Which leg of the run produced a driver file (#2262).
 *
 *  `fault` drives exactly as `steady` does and is a SEPARATE mode rather than a
 *  flag beside it, because the judge gathers every driver file out of one
 *  directory by mode: a fault pass written as `steady` would be folded into the
 *  steady pass's own latency, outcome and 5xx numbers, and the bar that says the
 *  path must not 5xx would then be measuring the faults the run injected on
 *  purpose. */
export type DriverMode = "steady" | "burst" | "fault";

export interface DriverResult {
  runId: string;
  driver: number;
  mode: DriverMode;
  /** How many requests the plan held, so a short file is visible as short. */
  planned: number;
  startedAtMs: number;
  finishedAtMs: number;
  /** Set only in burst mode, and only when the driver did not fire. */
  burstSkipped?: BurstReadiness;
  /**
   * Set only in fault mode: the percentage the DEPLOYMENT reported it was running
   * with, read from `/api/smoke/version` before a single request was sent.
   *
   * The percentage the job ASKED for is not this number. A fault pass whose
   * deployment never received the setting injects nothing, answers every request
   * perfectly, and satisfies the "no 5xx under fault" bar without a fault ever
   * having happened, which is the exact shape of a check that has never once
   * concluded (L98). So the driver records what it was told by the thing under
   * test, and refuses before driving when that is not what was asked for.
   */
  faultPct?: number;
  /**
   * Set only in fault mode, beside the percentage and for the same reason (#3104):
   * WHICH systems the deployment reported failing. The judge reads it to decide
   * which bar the pass is held to, so it is the deployment's word, never the job's.
   */
  faultTargets?: string[];
  attempts: BookingAttempt[];
}

/**
 * Which of the offered times the burst fires at, and when (#2262).
 *
 * ONE slot, chosen ONCE by the setup step and handed to every driver, because a
 * burst whose drivers each chose their own is not a burst: nothing contends and
 * everything succeeds.
 *
 * The LAST offered time, not the first, and that is the whole of the choice. The
 * preflight books the first time its own bucket offers, minutes earlier, and the
 * two buckets can share an agent: a burst aimed at a slot that agent is already
 * booked for meets SLOT_TAKEN on every request, and "exactly one 200" then fails
 * for a reason that has nothing to do with the unique index it is testing. The
 * furthest offered time is the one least likely to have been touched.
 *
 * Sorted here rather than trusted to arrive in order (L343): a list read out of a
 * response carries no order unless something declares one, and "the last element"
 * of an unordered list is not "the furthest away".
 */
export function chooseBurstSlot(slots: readonly string[]): string | null {
  const readable: { iso: string; ms: number }[] = [];
  for (const iso of slots) {
    const ms = Date.parse(iso);
    // An unreadable time is DROPPED rather than sorted, because NaN compares false
    // against everything and would land wherever the sort happened to put it,
    // making the choice depend on the input order this sort exists to remove (L50).
    if (Number.isFinite(ms)) readable.push({ iso, ms });
  }
  if (readable.length === 0) return null;
  readable.sort((a, b) => a.ms - b.ms);
  return readable[readable.length - 1]!.iso;
}

/**
 * The shared moment, far enough ahead that every driver is awake for it.
 *
 * The lead has to cover a runner being queued, checked out and installed, which is
 * the slowest part of the whole leg. Too short and drivers wake late, fire
 * nothing, and the judge calls the run incomplete: the burst is cheap to re-run
 * and a ten minute run judged without its control is not.
 */
export function burstStartAt(nowMs: number, leadSeconds: number): number {
  return nowMs + Math.max(0, Math.round(leadSeconds)) * 1000;
}

/**
 * The times a bucket is offering, read from `/api/availability` (#2261).
 *
 * ONE reader, because there were three and every one of them was wrong the same
 * way. The endpoint answers `slots` as an array of ISO **strings**; the driver,
 * the preflight and the burst setup each declared it as `{ start?: string }[]`
 * and mapped `s.start`, which is `undefined` for a string, so all three resolved
 * to an EMPTY list on a perfectly healthy response.
 *
 * That is the whole reason this is not three declarations (L41). It was invisible
 * because empty is a real answer: the driver records `no-slots-offered` and carries
 * on, the preflight says "this bucket is offering no times", and a run would have
 * reported six hundred bookings nobody could make against a branch that was
 * offering a hundred and thirty times a bucket. Measured against the real
 * deployment on 2026-09-11: 130 for code 112, 94 for 122, and every reader saw nil.
 *
 * So it THROWS on a shape it cannot read rather than returning `[]` (L98, L11). An
 * empty answer and an unreadable one are different facts, and the second one is
 * the one nothing noticed for a day: a reader that returns empty for both makes
 * the next shape change silent in exactly the same way.
 */
export function offeredSlots(body: unknown): string[] {
  if (typeof body !== "object" || body === null) {
    throw new Error("the availability response was not an object, so its times could not be read");
  }
  const slots = (body as { slots?: unknown }).slots;
  if (slots === undefined) {
    throw new Error(
      "the availability response carried no `slots` field at all, so its times could not be read",
    );
  }
  if (!Array.isArray(slots)) {
    throw new Error(`the availability response's \`slots\` was ${typeof slots}, not an array`);
  }
  const out: string[] = [];
  for (const s of slots) {
    if (typeof s === "string") {
      if (s !== "") out.push(s);
      continue;
    }
    // The exact shape all three readers assumed. Named rather than skipped,
    // because silently dropping it is what made this cost a day.
    const shape =
      typeof s === "object" && s !== null
        ? `an object with keys ${Object.keys(s as object).join(", ") || "(none)"}`
        : typeof s;
    throw new Error(
      `the availability response's \`slots\` held ${shape} where an ISO string was expected. ` +
        "The endpoint answers a list of strings; a reader expecting `{ start }` objects sees an " +
        "empty list on a healthy response.",
    );
  }
  return out;
}

/**
 * A phone number of this attempt's OWN, derived from its unique id (#2261).
 *
 * The dedupe gate is a PERSON gate, and a weak match is email OR phone
 * (`src/lib/booking/person-dedupe.ts`): one phone matching is enough to answer
 * `confirm_required` and refuse the booking. Every driver sent the same
 * `+15555550100`, so the first booking of a run would have succeeded and the other
 * five hundred and ninety nine would have been refused as the same person calling
 * again. The run would have reported a catastrophic confirmed-per-minute failure
 * that had nothing whatever to do with the booking path's capacity.
 *
 * The email was already unique per attempt, which is exactly why this hid: a
 * reader checking that the attendees differ sees an id in the address and stops.
 *
 * Kept in the 555 range, which is unassignable in the real numbering plan, so no
 * value this can produce is a number anybody actually holds. `toE164` returns the
 * string unchanged when it cannot parse it, so distinct seeds stay distinct to the
 * matcher either way. Seven varying digits rather than the four a fixed 555-555
 * prefix would leave, because a run makes six hundred of these and a branch can
 * see several runs.
 */
export function loadtestPhone(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const digits = String(Math.abs(h) % 10_000_000).padStart(7, "0");
  return `+1555${digits}`;
}

/**
 * The prefix every attempt's external id is built from, one space per leg (#2261).
 *
 * All three legs minted `<run>-<driver>-<n>`, so they COLLIDED, and `external_id`
 * IS the Salesforce id to Slate: a repeat is a strong match, which is answered by
 * RESCHEDULING the existing booking rather than by creating one.
 *
 * The first real run showed both halves of that. The fault pass runs as driver 0
 * and minted exactly the ids the steady pass had already used, so twenty seven of
 * its thirty requests were answered `rescheduled` and its "no 5xx under fault" bar
 * was asked of a different operation from the one the steady pass drove. The burst
 * runs first, and its two winners took ids the steady pass then reused, which is
 * precisely the two `rescheduled` in a steady mix that should have been six
 * hundred creates. Neither showed up as an error anywhere: a reschedule is a 200.
 *
 * Every prefix stays rooted at RUN_ID, because the judge scopes its database reads
 * to `external_id=like.<run>-*` and an id outside that is a row the run cannot see.
 */
export function idPrefix(runId: string, mode: "steady" | "burst" | "fault"): string {
  if (mode === "fault") return `${runId}-f`;
  if (mode === "burst") return `${runId}-b`;
  return runId;
}
