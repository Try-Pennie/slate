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
import { seededRosterVerdict } from "./roster-shape.ts";
import {
  AVAILABILITY_LIMITER,
  BOOKING_API_IP_LIMITER,
} from "../../src/lib/rate-limit-core.ts";
import { codeSequence, MEASURED_CODE_MIX, type CodeWeight } from "./code-mix.ts";
import { OK_P95_MS } from "./judge-booking-run.ts";
// Type only, erased under --experimental-strip-types: the attempt carries the echo the
// deployment sent, read through the one parser both sides share (#3325, L41).
import type { LoadtestEcho } from "../../src/lib/loadtest-echo.ts";
import { LOADTEST_LEG_HEADER, LOADTEST_LEGS, type LoadtestLeg } from "../../src/lib/booking/wait-marks.ts";
import { LOADTEST_RUN_HEADER } from "../../src/lib/loadtest-run-scope.ts";
// Type only: what a burst driver records from the deployment for the judge (#3429).
import type { BurstProbe, CrowdRuleReading } from "./burst-probe.ts";

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

/**
 * The steady pass's rate PER ADVISOR, held across roster sizes (#3829): today's four
 * drivers at fifteen a minute over production's 90. A 200 advisor run drives the
 * same pressure on each advisor rather than the same total, so what it measures is
 * the roster growing, not the traffic thinning out over it.
 */
export const STEADY_CONFIRMS_PER_ADVISOR_PER_MINUTE = (DRIVERS * PER_DRIVER_PER_MINUTE) / 90;

/**
 * How many steady drivers a roster of `advisors` takes at that rate, rounded UP so a
 * run never drives less per advisor than today's: 4 at 90, 9 at 200. Each driver
 * keeps its fifteen a minute, which keeps each driver's address under the booking
 * API's per address ceilings. The bursts do not grow with it: a crowd on one slot is
 * the same crowd whatever the roster, so they keep `DRIVERS`.
 */
export function steadyDriversFor(advisors: number): number {
  if (!Number.isSafeInteger(advisors) || advisors <= 0) {
    throw new Error(`a roster of ${advisors} advisors has no steady pass to size`);
  }
  // The small epsilon keeps 90 at exactly four: 90 * (60 / 90) / 15 is 4.000000000000001.
  return Math.ceil((advisors * STEADY_CONFIRMS_PER_ADVISOR_PER_MINUTE) / PER_DRIVER_PER_MINUTE - 1e-9);
}

/**
 * What the burst setup emits for the steady pass (#3829): the advisors COUNTED on the
 * branch, refused when they are not the roster the run names, the drivers that roster
 * takes, and the GITHUB_OUTPUT lines the drive matrix and the judge both read, so the
 * two are one number.
 */
export function steadyPlanFor(input: {
  seeded: number;
  named: string | undefined;
}): { ok: true; advisors: number; drivers: number[]; outputs: string } | { ok: false; why: string } {
  const roster = seededRosterVerdict(input);
  if (!roster.ok) return roster;
  const drivers = Array.from({ length: steadyDriversFor(roster.advisors) }, (_, i) => i);
  return {
    ok: true,
    advisors: roster.advisors,
    drivers,
    outputs:
      `steady_drivers=${JSON.stringify(drivers)}\nsteady_driver_count=${drivers.length}\n` +
      `roster_advisors=${roster.advisors}\n`,
  };
}

/**
 * The judge's steady expectation (#3829), from the workflow's EXPECT_STEADY_DRIVERS.
 * Unset is a hand run of today's four; a positive whole number is taken; anything
 * else is refused, never read as zero or NaN (L50).
 */
export function expectedSteadyDrivers(raw: string | undefined): { ok: true; drivers: number } | { ok: false; why: string } {
  const v = (raw ?? "").trim();
  if (v === "") return { ok: true, drivers: DRIVERS };
  if (!/^\d+$/.test(v) || Number(v) <= 0) {
    return { ok: false, why: `EXPECT_STEADY_DRIVERS is not a positive whole number: ${JSON.stringify(raw)}` };
  }
  return { ok: true, drivers: Number(v) };
}

/**
 * What one request costs a driver beside the booking's own wall time: the
 * availability read before it and the loop around it. Measured on run 37215457763
 * (2026-10-04) at a p50 of about 0.5s and a MAX of 1.65s between one booking's
 * reply and the next one being sent. The deadline is sized from the max, because
 * it has to clear the slowest run that still passes, not the typical one (#3163).
 */
export const PER_REQUEST_OVERHEAD_MAX_MS = 1_650;
/**
 * The most of the driver's deadline the slowest PASSING run may use (#3163, L743).
 * A driver cut short is failed as an incomplete plan, so a deadline sized at
 * exactly the passing worst case fails the borderline runs it was meant to let
 * the latency bar judge. The quarter left over covers what the at-the-bar sum
 * cannot see: the bar is a p95, so a few requests may sit above it, up to the
 * 30 second request timeout, in a run that still passes.
 */
export const DEADLINE_WORST_CASE_SHARE = 0.75;
/**
 * How long a drive runner spends being checked out and installed before the driver
 * starts its clock. Measured at about 30s on run 37215457763; the rest is headroom
 * for a slow install, which the driver's own deadline cannot see.
 */
export const DRIVE_JOB_SETUP_MINUTES = 3;
/**
 * Between the driver's deadline and the job's timeout: the one request already in
 * flight when the deadline passes (12s was the slowest seen) and writing the file.
 */
export const DRIVE_DEADLINE_GRACE_MINUTES = 2;
/**
 * The longest a burst driver's runner has been seen to START after the burst plan was
 * made, in seconds: 395 on run 38912230442 (2026-10-16), when GitHub's queue was
 * backed up after a billing block, against 3 to 86 on the four runs before it. That
 * run's last driver started after all three burst moments, fired nothing, and failed
 * the run for nothing Slate did. The default lead must cover this plus the driver's
 * own checkout and install (`DRIVE_JOB_SETUP_MINUTES`).
 */
export const BURST_RUNNER_START_WORST_SECONDS = 395;

/**
 * When a driver stops on its own, measured from its first request (#3222).
 *
 * The drivers send one request at a time, so a slow deployment stretches the run
 * rather than overlapping requests. Run 37215457763 took fourteen to sixteen minutes
 * for a ten minute plan, and one driver met the job's timeout: it was killed, wrote
 * nothing, and the judge could only call the run incomplete. So the driver keeps its
 * own deadline and writes what it ran when it meets it.
 *
 * Sized from the slowest driver that still PASSES, every request at the latency bar
 * plus the slowest overhead measured between them, held at no more than
 * `DEADLINE_WORST_CASE_SHARE` of the deadline, and never less than the plan's own
 * span (#3163, L743). Sized at exactly that time, as it first was, a passing run with
 * a few slow gaps met the deadline and was failed as incomplete. A driver that cannot
 * finish by then was far slower than the bar, which is the run the judge must FAIL
 * with figures rather than lose. The bar is the judge's own constant, so moving it
 * moves the deadline with it (L41).
 */
export function driverDeadlineMs(plan: { total: number; perMinute: number }): number {
  const span = plan.perMinute > 0 ? plan.total * (60_000 / plan.perMinute) : 0;
  const slowestPassing = plan.total * (OK_P95_MS + PER_REQUEST_OVERHEAD_MAX_MS);
  return Math.max(span, Math.ceil(slowestPassing / DEADLINE_WORST_CASE_SHARE));
}

/**
 * The drive job's `timeout-minutes`, derived from the deadline (#3222).
 *
 * Longer than the deadline by the runner's setup and one request's grace, so the
 * platform only ever kills a driver that is genuinely hung: a slow one has already
 * stopped itself and written its file. `scripts/test-loadtest-driver-deadline.ts`
 * holds the workflow's number equal to this one, so the two cannot drift.
 */
export function driveJobTimeoutMinutes(plan: { total: number; perMinute: number }): number {
  return Math.ceil(
    driverDeadlineMs(plan) / 60_000 + DRIVE_JOB_SETUP_MINUTES + DRIVE_DEADLINE_GRACE_MINUTES,
  );
}

/**
 * The deadline a driver actually keeps: the derived one, or a SHORTER override.
 *
 * The override exists so a test can watch the real driver stop in milliseconds. It
 * can only shorten, because a longer deadline would let the job's timeout fire first
 * and turn a slow run back into a silent one; an unreadable value is ignored rather
 * than becoming a NaN every comparison reads as "not yet" (L50).
 */
export function effectiveDeadlineMs(derivedMs: number, raw: string | undefined): number {
  const v = Number((raw ?? "").trim());
  if ((raw ?? "").trim() === "" || !Number.isFinite(v) || v <= 0) return derivedMs;
  return Math.min(derivedMs, v);
}

/**
 * Whether the driver should stop rather than send its next request.
 *
 * Also when the next request is SCHEDULED after the deadline, so a driver never
 * sleeps toward a request it is not going to send.
 */
export function deadlineReached(opts: { nowMs: number; nextAtMs: number; deadlineAtMs: number }): boolean {
  return opts.nowMs >= opts.deadlineAtMs || opts.nextAtMs >= opts.deadlineAtMs;
}

/**
 * How long one request may take before the driver gives up on it (#3222). Well past
 * the slowest confirm seen (12s on run 37215457763), so it records a hang rather
 * than a slow answer.
 */
export const REQUEST_TIMEOUT_MS = 30_000;
/**
 * How far a request already in flight may run past the driver's deadline. Inside
 * the grace before the job's timeout, with room left to write the file, so a request
 * that never answers can no longer keep the driver from writing it.
 */
export const REQUEST_OVERRUN_MS = 60_000;

/**
 * The two kinds of burst a run fires (#3429).
 *
 * `refusal`: the crowd of a hundred at a ladder whose WHOLE capacity is smaller than
 * the crowd, measured from the roster. Once a crowd walks the tier ladder (#3338,
 * #3437), a hundred confirms at a code whose lower rungs hold a whole tier mostly WIN,
 * so the refusal path and the line's settle path are exercised only where the ladder
 * genuinely runs out. It carries the loser speed bar.
 *
 * `drop`: about ten confirms at a code whose top rung is shallow and whose ladder holds
 * at least twice the crowd, at a slot where the top rung has somebody free. On a build
 * that walks the ladder every one of them wins, on distinct advisors, and at least one
 * on a lower rung, which is what proves the #3338 drop happens at all.
 */
export const BURST_KINDS = ["refusal", "drop"] as const;
export type BurstKind = (typeof BURST_KINDS)[number];

/**
 * The run's bursts in firing order (#3325, #3429), each at its own slot and moment and
 * each judged on its own. The refusal control is fired twice because its loser speed
 * bar is a timing claim, and one spread of a crowd over the deployment's isolates can
 * pass a run a second would fail (L395). The drop burst is a correctness demonstration
 * that a single counterexample decides, fired once between them; a second drop
 * reading is the lever not pulled here, since a fourth burst would leave the burst
 * tail's ceiling no headroom at the default lead (L308).
 */
export const BURST_SEQUENCE: readonly BurstKind[] = ["refusal", "drop", "refusal"];
/** How many bursts one run fires: the sequence's length, so the two are one number (L41). */
export const BURST_LEGS = BURST_SEQUENCE.length;
/** Requests one burst driver fires in a REFUSAL burst: four drivers make the crowd of a hundred. */
export const BURST_REQUESTS_DEFAULT = 25;
/** #3429: requests one burst driver fires in a DROP burst: four drivers make twelve. */
export const DROP_BURST_REQUESTS_PER_DRIVER = 3;

/** How many requests one driver fires in a burst of this kind. */
export function burstRequestsPerDriver(kind: BurstKind): number {
  return kind === "drop" ? DROP_BURST_REQUESTS_PER_DRIVER : BURST_REQUESTS_DEFAULT;
}

/** The whole crowd one burst of this kind fires across every driver. */
export function burstCrowd(kind: BurstKind): number {
  return DRIVERS * burstRequestsPerDriver(kind);
}

/**
 * #3429: the drop burst's ladder must hold at least this many times its crowd, free at
 * the slot when planned, so a booking made between the plan and the burst cannot turn
 * the drop burst into a refusal and every confirm can win.
 */
export const DROP_CAPACITY_HEADROOM = 2;

/**
 * How many of a drop ladder's offered times the burst setup measures for capacity,
 * furthest first. Each measurement is the booker's own candidate read on every rung of
 * the ladder, against the branch database rather than the deployment, so it spends no
 * availability read. Slots are measured one at a time, so when nothing fits the search
 * costs about this many times the ladders asked times a ladder's rung reads; that worst
 * case has not been timed (run 37871606406's whole pick, which fit early, took 12s). The
 * setup job's ten minute limit bounds it, and a slow pick only lengthens the run, since
 * the bursts' moments are set after it. #3529: 24 reached only tomorrow's last hours, so
 * a run launched late in the afternoon found no slot with room (run 37838336896); it
 * reaches two working days back.
 */
export const DROP_SLOTS_TO_MEASURE = 144;

/**
 * #3565: how many of the refusal ladder's offered times, furthest first, the setup measures
 * looking for one with enough advisors free for the hard refusal crowd
 * (`HARD_REFUSAL_MIN_FREE`). A day's worth of ten minute slots: far out, most of a seeded
 * roster is free, so the first few usually fit.
 */
export const REFUSAL_SLOTS_TO_MEASURE = 72;

/**
 * #3429: how long one probe of a burst's slot may take. Held, with the moment the
 * burst settles, inside the spacing to the next burst, so no probe overlaps a crowd.
 */
export const BURST_PROBE_TIMEOUT_MS = 20_000;

/**
 * #3429: when every confirm of a burst is over, so its slot can be asked whether it is
 * still bookable. The latest a driver may fire (its grace) plus a request's own abort
 * bound: past that no burst request is in flight on any driver, and the confirm's own
 * budget (`BOOKING_CONFIRM_WORST_CASE_MS`) is inside the bound, so nothing is still
 * walking the ladder when the probe asks. Both are passed explicitly, so a driver whose
 * test seams shortened them settles sooner and the judge uses the run's own defaults.
 */
export function burstSettleAtMs(momentMs: number, graceMs: number, requestTimeoutMs: number): number {
  return momentMs + graceMs + requestTimeoutMs;
}

/**
 * #3429: the request numbers burst `index` uses, given every burst's share per driver,
 * so each burst starts past every earlier one's and no two of a run's requests share an
 * external id whatever the shares are (#2261).
 */
export function burstRequestNumbers(shares: readonly number[], index: number): number[] {
  const start = shares.slice(0, index).reduce((n, s) => n + s, 0);
  return Array.from({ length: shares[index] ?? 0 }, (_, i) => start + i);
}
/** How late a burst driver may wake and still be part of the burst, when BURST_GRACE_MS is unset. */
export const BURST_GRACE_DEFAULT_MS = 2_000;
/**
 * The time between one burst's moment and the next (#3325).
 *
 * Derived, not picked: every burst request carries the driver's own abort bound, so a
 * burst is over by `REQUEST_TIMEOUT_MS` past its moment plus the lateness a driver is
 * allowed. Twice the timeout leaves the next moment well past that, so two bursts
 * never overlap and each is the contention it is counted as. It also lets whatever
 * the confirm line held for one burst (its followers' polls, its leader's lease, a
 * few seconds at most) clear before the next.
 */
export const BURST_SPACING_MS = REQUEST_TIMEOUT_MS * 2;
/**
 * How far apart in TIME the three slots are (#3325).
 *
 * An hour is longer than any appointment plus its buffers (twenty minutes and ten
 * either side in production), so a booking one burst makes, on any rung of the
 * ladder, cannot overlap the slot another burst fires at. Closer slots would make the
 * second burst's refusals partly the first burst's bookings.
 */
export const BURST_SLOT_GAP_MS = 60 * 60_000;

/**
 * The whole minutes a burst driver's job needs at a given lead (#3325): the lead to
 * the first moment, the spacing to the last, the moment that burst settles (its
 * requests' own timeout plus the lateness a driver may fire at), the probe of its slot
 * after that (#3429), and the runner's setup. The workflow's burst job timeout is held
 * at or above this at its default lead.
 */
export function burstJobMinutesNeeded(leadSeconds: number): number {
  const lastMomentMs = leadSeconds * 1000 + (BURST_LEGS - 1) * BURST_SPACING_MS;
  const workMs = burstSettleAtMs(lastMomentMs, BURST_GRACE_DEFAULT_MS, REQUEST_TIMEOUT_MS) + BURST_PROBE_TIMEOUT_MS;
  return Math.ceil(workMs / 60_000) + DRIVE_JOB_SETUP_MINUTES;
}

/**
 * #3416: how long after a burst answer its invocation's log lines can still be on
 * their way. `wrangler tail` writes an invocation's event when the invocation ENDS,
 * which is after the work deferred past the response, and the platform cancels that
 * work 30 seconds after the response ends (docs/cloudflare-platform-notes.md, #2922).
 */
export const AFTER_RESPONSE_CANCEL_MS = 30_000;

/**
 * #3416: the stream's own lag behind an invocation ending. The cold job's tail meets
 * it as "a few seconds" (the workflow's comment where that job waits past its last
 * confirm before stopping its tail); ten is room above that.
 */
export const TAIL_DELIVERY_MARGIN_MS = 10_000;

/**
 * #3416: how long past the LAST burst's moment the burst tail keeps streaming. Derived
 * rather than read off one run: the lateness a driver may still fire at, a burst
 * request's own abort bound (the driver records no answer later than that), the work
 * the platform allows after an answer, and the stream's lag. The slowest burst answer
 * seen (14119ms on run 37520312761) is inside it by construction.
 */
export const BURST_TAIL_AFTER_LAST_MOMENT_MS =
  BURST_GRACE_DEFAULT_MS + REQUEST_TIMEOUT_MS + AFTER_RESPONSE_CANCEL_MS + TAIL_DELIVERY_MARGIN_MS;

/** #3416: when the burst tail stops: the plan's last moment plus the margin above. */
export function burstTailStopAtMs(plan: BurstPlan): number {
  return plan.bursts[plan.bursts.length - 1]!.startAtMs + BURST_TAIL_AFTER_LAST_MOMENT_MS;
}

/**
 * #3416: the whole minutes the burst tail can stream at a given lead: from the moment
 * the setup chose the plan (the tail starts after it) to the stop. The job's ceiling
 * on the tail is held at or above this at the workflow's default lead.
 */
export function burstTailMinutesNeeded(leadSeconds: number): number {
  return Math.ceil((leadSeconds * 1000 + (BURST_LEGS - 1) * BURST_SPACING_MS + BURST_TAIL_AFTER_LAST_MOMENT_MS) / 60_000);
}

/** #3416: how long the burst tail is held open, and what it could not cover. */
export type BurstTailWait =
  | {
      ok: true;
      /** How long to keep the tail open from now. */
      waitMs: number;
      stopAtMs: number;
      /** 0 when the window covers every burst; 3 when it cannot, which is said in `lines`. */
      exit: 0 | 3;
      lines: string[];
    }
  | { ok: false; why: string };

/**
 * #3416: the burst tail's wait, from the plan the drivers fire and the ceiling the tail
 * runs under. A tail that starts after the first burst's moment, or whose ceiling ends
 * before the stop, cannot cover every burst; it still streams what it can, and says
 * so with exit 3 rather than reading as a whole window (L98). An unreadable plan or
 * ceiling is refused by name, never read as a NaN wait (L50).
 */
export function burstTailWait(opts: { rawPlan: string; rawCeilingMinutes: string; nowMs: number }): BurstTailWait {
  const read = readBurstPlan(opts.rawPlan);
  if (!read.ok) return { ok: false, why: `${read.why}, so the burst tail has no moment to stop at` };
  const rawCeiling = opts.rawCeilingMinutes.trim();
  if (!/^\d+$/.test(rawCeiling) || Number(rawCeiling) <= 0) {
    return { ok: false, why: `BURST_TAIL_CEILING_MINUTES is not a whole number of minutes above 0: ${JSON.stringify(opts.rawCeilingMinutes)}` };
  }
  const ceilingMs = Number(rawCeiling) * 60_000;
  const plan = read.plan;
  const stopAtMs = burstTailStopAtMs(plan);
  const first = plan.bursts[0]!.startAtMs;
  const lines: string[] = [];
  let exit: 0 | 3 = 0;
  if (opts.nowMs >= first) {
    exit = 3;
    lines.push(
      `the burst tail started ${Math.round((opts.nowMs - first) / 1000)}s after burst 1's moment ` +
        `(${new Date(first).toISOString()}), so that burst's first confirms may be missing from it; ` +
        "raise burst_lead_seconds",
    );
  }
  let waitMs = Math.max(0, stopAtMs - opts.nowMs);
  if (waitMs > ceilingMs) {
    exit = 3;
    waitMs = ceilingMs;
    lines.push(
      `the tail's ceiling, BURST_TAIL_CEILING_MINUTES (${rawCeiling}), ends before the last burst's lines are in ` +
        `(${new Date(stopAtMs).toISOString()}), so the last burst is cut short; raise it with the lead`,
    );
  }
  const last = new Date(plan.bursts[plan.bursts.length - 1]!.startAtMs).toISOString();
  if (stopAtMs <= opts.nowMs) {
    lines.push(`the burst tail started after its stop moment (${new Date(stopAtMs).toISOString()}), so it covered no burst`);
  } else {
    lines.push(
      `streaming until ${new Date(opts.nowMs + waitMs).toISOString()}, ` +
        `${Math.round(BURST_TAIL_AFTER_LAST_MOMENT_MS / 1000)}s past burst ${plan.bursts.length}'s moment (${last})`,
    );
  }
  return { ok: true, waitMs, stopAtMs, exit, lines };
}

/**
 * The abort bound for a request sent now: its own timeout, or the time left until
 * the deadline plus the overrun, whichever is sooner. Never below one millisecond,
 * because a zero or negative bound would abort before the request was sent and
 * record a timeout nobody waited for.
 */
export function requestAbortMs(opts: { nowMs: number; deadlineAtMs: number }): number {
  return Math.max(1, Math.min(REQUEST_TIMEOUT_MS, opts.deadlineAtMs + REQUEST_OVERRUN_MS - opts.nowMs));
}

/**
 * #3566: the abort bound for one send of a request whose bound was fixed when it was
 * FIRST sent (`abortAtMs`): what is left of it, never below one millisecond. A resend
 * after a dropped connection shares the first send's abort instant instead of starting
 * a fresh bound, so a request is never in flight later than it could be before resends
 * existed, and every window derived from one request's bound (the burst's settle and
 * probe, its tail, its job) still holds.
 */
export function sendBoundMs(abortAtMs: number, nowMs: number): number {
  return Math.max(1, abortAtMs - nowMs);
}

/** The fault pass's length when FAULT_MINUTES is unset, which is how the workflow runs it. */
export const FAULT_MINUTES_DEFAULT = 2;

/**
 * The fault pass's length from `FAULT_MINUTES`, read ONE way by the driver that runs
 * it and the judge that checks the file against it, so a hand run that sets it is not
 * judged against the default plan. Null for anything that is not a positive number,
 * never a NaN every comparison reads as "fine" (L50).
 */
export function faultMinutesFrom(raw: string | undefined): number | null {
  const v = (raw ?? "").trim();
  if (v === "") return FAULT_MINUTES_DEFAULT;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * How long the archive job streams the Worker's logs (#3222). It starts beside the
 * drive, and must outlast the longest a drive job can run, or a slow run loses the
 * last lines the judge reads its confirm timings from. One minute of margin past the
 * drive job's own timeout.
 */
export function archiveTailMinutes(plan: { total: number; perMinute: number }): number {
  return driveJobTimeoutMinutes(plan) + 1;
}

/** The archive job's `timeout-minutes`: its window plus the same runner setup. */
export function archiveJobTimeoutMinutes(plan: { total: number; perMinute: number }): number {
  return archiveTailMinutes(plan) + DRIVE_JOB_SETUP_MINUTES;
}

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

/** At most this many sleeps toward the moment, so a clock that never advances cannot hang a driver. */
const BURST_WAIT_MAX_SLEEPS = 50;

/**
 * Sleep until the WALL clock has reached the burst's moment (#3103).
 *
 * One sleep is not enough. `setTimeout` runs on a monotonic clock and `Date.now()`
 * on the wall clock, so a timer can return a millisecond or two before the moment
 * the wall clock names. Run 37162784607 lost its whole run to exactly that: one
 * driver woke 1 to 3 ms early, `burstReadiness` correctly said "early", and the
 * driver fired nothing. So this sleeps again for whatever is left, until the clock
 * reads the moment or later. A driver already past the moment does not sleep, and
 * `burstReadiness` still decides whether it is too late to fire.
 */
export async function waitForBurstMoment(
  startAtMs: number,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<void> {
  for (let i = 0; i < BURST_WAIT_MAX_SLEEPS; i++) {
    const wait = startAtMs - clock.now();
    if (wait <= 0) return;
    await clock.sleep(wait);
  }
}

/**
 * One attempt of a run, which every part of its identity is derived from (#3447):
 * the external id, the address and the phone number. Deriving all three from one
 * value is what stops an id and a number ever describing two different attempts.
 */
export interface LoadtestLead {
  runId: string;
  leg: LoadtestLeg;
  driver: number;
  /** The request's number within its driver and leg. */
  n: number;
}

/**
 * The external id an attempt books under. Every driver leg and the cold leg take
 * their leg's prefix (`idPrefix`); the preflight and the ceiling control keep the
 * ids they have always had, which the judge and the preflight look them up by.
 */
export function leadExternalId(lead: LoadtestLead): string {
  if (lead.leg === "preflight") return `${lead.runId}-preflight`;
  if (lead.leg === "ceiling") return `ceiling-control-${lead.n}`;
  return externalIdFor(idPrefix(lead.runId, lead.leg), lead.driver, lead.n);
}

/**
 * What an attempt's record says about who it was: its driver, request number and
 * external id, all from its one lead (#3447), so a record and the id it booked
 * under can never name two different requests.
 */
export function attemptIdentity(lead: LoadtestLead): { driver: number; n: number; externalId: string } {
  return { driver: lead.driver, n: lead.n, externalId: leadExternalId(lead) };
}

/**
 * The ceiling control's dry run (#2339), from its lead like every other sender's
 * body (#3447). Its leads sit outside any run's scope, since a dry run writes no
 * row. Built before the request is sent, so a request number outside the phone's
 * digits throws here, by name, rather than inside the send where it would be
 * recorded as a request that failed in transit.
 */
export function ceilingControlBody(n: number, code: string, startIso: string): string {
  const lead: LoadtestLead = { runId: "ceiling-control", leg: "ceiling", driver: 0, n };
  const externalId = leadExternalId(lead);
  return JSON.stringify({
    bucketCode: code,
    start: startIso,
    timezone: "America/New_York",
    externalId,
    dryRun: true,
    attendee: {
      name: "Ceiling Control",
      email: `${externalId}@loadtest.local`,
      // Its own number like every other caller (#2261). These are dry runs, so the
      // person gate cannot refuse them anyway, but one shared identity across the
      // load machinery is the footgun that change removed.
      phone: loadtestPhone(lead),
    },
  });
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
 * RANDOM for the steady and fault legs, and this is the one place a load run is
 * deliberately not deterministic (the baseline takes the soonest time instead,
 * `baselineSlot`, #3782). Every other choice (the code, the fault, the order) is fixed so that a run that
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

/**
 * The time a BASELINE booking takes: the soonest on offer (#3782). The bursts are planned
 * on the latest times, and the tier drop burst's ladders offer only a handful, so a
 * baseline booking taken at random could land on one and take an advisor the burst could
 * not spare (runs 38761057057 and 38800509328). A time that does not parse is skipped,
 * and so is one the baseline already sent a booking at: it books the same codes every
 * run, and four bookings at one slot would walk the ladder or be refused rather than
 * book at rest.
 */
export function baselineSlot(slots: readonly string[], booked: ReadonlySet<string> = new Set()): string | null {
  let soonest: string | null = null;
  let soonestMs = Infinity;
  for (const t of slots) {
    const ms = Date.parse(t);
    if (Number.isFinite(ms) && ms < soonestMs && !booked.has(t)) {
      soonest = t;
      soonestMs = ms;
    }
  }
  return soonest;
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
  /**
   * What the deployment echoed on the response (#3325): which confirm line served it,
   * why, under which key, the time the line added, and when the deployment built the
   * answer. Read through the one parser the deployment's builders are tested against,
   * and kept per field as absent, unreadable or read, so a header that never arrived
   * is never recorded as a value. Null when no response arrived at all (nothing was
   * offered, or the request never got an answer).
   */
  echo: LoadtestEcho | null;
  /**
   * #3429: how many rungs below the requested one the booking landed, from a 200's own
   * `bucket.rungsDropped`, or null when the answer did not say. Absent on an attempt
   * that was not answered 200. The drop burst reads it to show a tier was dropped at
   * all; a missing figure reads as not dropped, never as dropped.
   */
  rungsDropped?: number | null;
  /**
   * #3566: present when the first send's connection dropped and the driver sent it once
   * more, as the booker does for a lead: what that first send failed with. The record is
   * otherwise the resend's, timed from the first send. Absent on a request answered first
   * time, so a run with no resend reads exactly as before.
   */
  resentAfter?: string;
}

/** The prefix every connection failure's outcome starts with, so the judge and the driver read one spelling. */
export const TRANSPORT_OUTCOME_PREFIX = "transport: ";

/** How long a recorded cause may be: enough to name it, never enough to bloat a report. */
const TRANSPORT_CAUSE_MAX = 100;

/**
 * #3566: a connection failure, named with its cause. Node's fetch throws a bare
 * `TypeError: fetch failed` and puts what actually happened (a reset socket, a DNS
 * miss) on `cause`, so recording only the name, as the driver did, threw away the one
 * fact anybody would ask for. The code when there is one, else the message, cut short.
 */
export function transportOutcome(err: unknown): string {
  const name = (err as { name?: string } | null)?.name ?? "Error";
  const cause = (err as { cause?: unknown } | null)?.cause as { code?: unknown; message?: unknown } | undefined;
  const why =
    typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : null;
  if (!why) return `${TRANSPORT_OUTCOME_PREFIX}${name}`;
  const short = why.length > TRANSPORT_CAUSE_MAX ? `${why.slice(0, TRANSPORT_CAUSE_MAX)}...` : why;
  return `${TRANSPORT_OUTCOME_PREFIX}${name} (${short})`;
}

/** #3566: a request that got no reply of any kind, which is the only kind the driver resends. */
export function droppedAttempt(a: BookingAttempt): boolean {
  return a.status === 0 && (a.outcome ?? "").startsWith(TRANSPORT_OUTCOME_PREFIX);
}

/**
 * #3566: the record for a request that may have been resent (`resendOnce`). The
 * resend's answer, timed from the first send, since the lead waited through both and
 * the pause, and carrying what the first send failed with.
 */
export function afterResend(o: { result: BookingAttempt; firstFailure: BookingAttempt | null }): BookingAttempt {
  if (!o.firstFailure) return o.result;
  const first = o.firstFailure;
  return {
    ...o.result,
    sentAtMs: first.sentAtMs,
    wallMs: o.result.sentAtMs + o.result.wallMs - first.sentAtMs,
    resentAfter: first.outcome ?? `${TRANSPORT_OUTCOME_PREFIX}unknown`,
  };
}

/**
 * #3429: what the setup measured about a burst's capacity, for the report. Every
 * figure is a count of advisors, or null when it was not measured: "nobody measured
 * it" and "nobody was free" are the two readings a zero would merge (L98).
 */
export interface BurstCapacity {
  /** The most advisors the code's WHOLE ladder holds, from the roster: a bound at any slot. */
  ladderRoster: number | null;
  /** Advisors free at the slot on the requested rung, through the booker's own candidate read, when planned. */
  rung0Free: number | null;
  /** Distinct advisors free at the slot across the whole ladder, the same way, when planned. */
  ladderFree: number | null;
}

/** Which burst of the run a burst driver file holds (#3325). */
export interface BurstLegRecord {
  /** Zero based, in firing order. */
  index: number;
  /** How many bursts the run's plan held. */
  of: number;
  /** The slot every request in this burst asked for. */
  slot: string;
  /** The two sibling codes the burst was split across. */
  codes: string[];
  /** The shared moment, epoch ms. */
  startAtMs: number;
  /**
   * #3429: which kind of burst it was. Absent on a file from before #3429, which was
   * always the crowd at one slot that the refusal control still is.
   */
  kind?: BurstKind;
  /** #3429: what the setup measured about its capacity. Absent on a file from before #3429. */
  capacity?: BurstCapacity;
  /**
   * #3429: how late this driver could have fired (its `BURST_GRACE_MS`), and the abort
   * bound its requests carried, as it was configured. The judge settles the burst on
   * the longest of each across its drivers. Absent on a file from before the drivers
   * recorded them, which is read on the run's own defaults.
   */
  graceMs?: number;
  requestBoundMs?: number;
}

/** What one driver writes when it finishes. The judge refuses without all of them. */
/** Which leg of the run produced a driver file (#2262).
 *
 *  `fault` drives exactly as `steady` does and is a SEPARATE mode rather than a
 *  flag beside it, because the judge gathers every driver file out of one
 *  directory by mode: a fault pass written as `steady` would be folded into the
 *  steady pass's own latency, outcome and 5xx numbers, and the bar that says the
 *  path must not 5xx would then be measuring the faults the run injected on
 *  purpose. `baseline` (#3258) is the same day measurement at rest that the steady
 *  pass's latency is judged against, and is kept apart for the same reason. */
export type DriverMode = (typeof DRIVER_MODES)[number];

/**
 * #3354: the modes a driver runs, each one a leg the route reads (`LOADTEST_LEGS`),
 * so the two vocabularies cannot drift. The preflight and the address ceiling are
 * legs too, sent by their own scripts, and are not modes here.
 */
export const DRIVER_MODES = ["steady", "burst", "fault", "baseline"] as const satisfies readonly LoadtestLeg[];

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
   * Set only in burst mode: which of the run's bursts this file holds (#3325). A
   * driver writes one file per burst, so a driver that missed one burst still hands
   * the judge the others whole.
   */
  burstLeg?: BurstLegRecord;
  /**
   * #3429, burst mode only: the confirm crowd rule the deployment declared before the
   * burst fired, so the judge holds the burst to the rule of the build it measured.
   */
  crowdRule?: CrowdRuleReading;
  /**
   * #3429, burst mode only: this driver's probe of the burst's slot once the burst had
   * settled. Absent on a burst the driver did not fire, and on a file written before
   * the probe returned, which the judge reads as a probe never recorded.
   */
  probe?: BurstProbe;
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
  /**
   * Set only when the driver stopped at its own deadline before its plan was done
   * (#3222). The file is still whole: `attempts` is everything it sent, and
   * `attemptsMade` says how many that was, so the judge can tell a well formed
   * partial run from a file that lost entries. A driver that wrote no file at all
   * hung or crashed, which is a different finding.
   */
  cutShort?: { deadlineMs: number; attemptsMade: number };
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
  return chooseBurstSlots(slots, 1, 0)?.[0] ?? null;
}

/**
 * The slots a run's bursts fire at, one per burst, in time order (#3325), or null
 * when there are not `count` of them at least `minGapMs` apart.
 *
 * The furthest offered time first, for the reason one burst always took it, then the
 * latest earlier time at least the gap before the last one chosen, and so on. Never
 * fewer than asked: a plan of three bursts handed two slots would fire two and the
 * judge would count a third that never had a slot.
 *
 * Unreadable times are DROPPED rather than sorted, and the list is sorted here rather
 * than trusted to arrive in order (L50, L343), exactly as one slot always was.
 */
export function chooseBurstSlots(slots: readonly string[], count: number, minGapMs: number): string[] | null {
  const readable: { iso: string; ms: number }[] = [];
  for (const iso of slots) {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) readable.push({ iso, ms });
  }
  readable.sort((a, b) => a.ms - b.ms);
  const chosen: { iso: string; ms: number }[] = [];
  for (let i = readable.length - 1; i >= 0 && chosen.length < count; i--) {
    const last = chosen[chosen.length - 1];
    if (last === undefined || last.ms - readable[i]!.ms >= minGapMs) chosen.push(readable[i]!);
  }
  if (count <= 0 || chosen.length < count) return null;
  return chosen.reverse().map((c) => c.iso);
}

/** Each burst's shared moment, `spacingMs` apart from the first (#3325). */
export function burstMoments(startAtMs: number, legs: number, spacingMs: number): number[] {
  return Array.from({ length: Math.max(0, legs) }, (_, i) => startAtMs + i * spacingMs);
}

/**
 * Which of the two sibling codes request `i` of driver `driver` asks for (#3325).
 *
 * Alternating within a driver, and opening on a different code per driver, so four
 * drivers of twenty five split a burst fifty fifty and neither code's requests are
 * bunched at the start of the burst.
 */
export function burstCodeFor(codes: readonly [string, string] | readonly string[], driver: number, i: number): string {
  return codes[(driver + i) % 2]!;
}

/** The file one burst's results go to, beside the driver's own name (#3325). */
export function burstLegOut(out: string, index: number): string {
  return `${out.replace(/\.json$/, "")}-leg-${index}.json`;
}

/** One burst of the plan (#3325, #3429): its kind, its own two codes, slot, moment and share. */
export interface PlannedBurst {
  kind: BurstKind;
  /** The two sibling codes it is split across, measured to share a fallback ladder. */
  codes: [string, string];
  /**
   * #3495: the tier each of `codes` had on show when the setup read its availability,
   * in the same order, or null where the answer named none. Every booking hands back
   * its own code's, as the booker hands back the tier it had on show, so the confirm
   * records it instead of reading the cache for it, which is the read the burst is
   * built to cost.
   */
  shownTiers: [string | null, string | null];
  slot: string;
  startAtMs: number;
  /** Requests each driver fires in it. */
  perDriver: number;
  /** What the setup measured about its capacity, for the report. */
  capacity: BurstCapacity;
}

/** The burst plan the setup chose once and every driver fires (#3325). */
export interface BurstPlan {
  /** One per burst, in firing order. */
  bursts: PlannedBurst[];
}

/** A capacity figure: a whole count of advisors, or null for one nobody measured. */
function isCapacityFigure(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0);
}

/**
 * The plan from `BURST_PLAN`, or the reason it cannot be fired (#3325).
 *
 * Read strictly, and refused by name, because a plan this half read would be a burst
 * nobody configured: a kind the judge does not know, one code instead of two, a slot
 * that is not a time (every request then refused as a validation error and counted as
 * a loser), a share that is not a whole number of requests, a capacity that is not a
 * count, or moments out of order, which would have a driver wait past one burst to
 * fire the next late.
 */
export function readBurstPlan(raw: string): { ok: true; plan: BurstPlan } | { ok: false; why: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, why: "BURST_PLAN is not JSON" };
  }
  const p = parsed as { bursts?: unknown } | null;
  if (typeof p !== "object" || p === null) return { ok: false, why: "BURST_PLAN is not an object" };
  const bursts = p.bursts;
  if (!Array.isArray(bursts) || bursts.length === 0) return { ok: false, why: "BURST_PLAN holds no bursts" };
  const out: PlannedBurst[] = [];
  for (const [i, entry] of bursts.entries()) {
    const n = i + 1;
    const b = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    const kind = b.kind;
    if (typeof kind !== "string" || !(BURST_KINDS as readonly string[]).includes(kind)) {
      return { ok: false, why: `BURST_PLAN burst ${n}'s kind is not one of ${BURST_KINDS.join(", ")}: ${JSON.stringify(kind)}` };
    }
    const codes = b.codes;
    if (!Array.isArray(codes) || codes.length !== 2 || !codes.every((c) => typeof c === "string" && c.trim() !== "")) {
      return { ok: false, why: `BURST_PLAN burst ${n} must name exactly two codes, the burst's and its sibling's` };
    }
    if (codes[0] === codes[1]) {
      return { ok: false, why: `BURST_PLAN burst ${n} must name two different codes, and names ${codes[0]} twice` };
    }
    // #3495: one per code, each a tier name or null. A missing list is refused rather
    // than read as "no tier", which would put the cache read back on every request
    // with nothing to say the burst had changed what it measures.
    const tiers = b.shownTiers;
    const isTier = (t: unknown) => t === null || (typeof t === "string" && t.trim() !== "");
    if (!Array.isArray(tiers) || tiers.length !== 2 || !tiers.every(isTier)) {
      return { ok: false, why: `BURST_PLAN burst ${n} must name the tier each of its two codes had on show (or null): ${JSON.stringify(tiers)}` };
    }
    const slot = b.slot;
    if (typeof slot !== "string" || !Number.isFinite(Date.parse(slot))) {
      return { ok: false, why: `BURST_PLAN burst ${n}'s slot is not a time: ${JSON.stringify(slot)}` };
    }
    const startAtMs = b.startAtMs;
    if (typeof startAtMs !== "number" || !Number.isSafeInteger(startAtMs) || startAtMs <= 0) {
      return { ok: false, why: `BURST_PLAN burst ${n}'s moment is not epoch milliseconds: ${JSON.stringify(startAtMs)}` };
    }
    const perDriver = b.perDriver;
    if (typeof perDriver !== "number" || !Number.isSafeInteger(perDriver) || perDriver <= 0) {
      return { ok: false, why: `BURST_PLAN burst ${n}'s share per driver is not a whole number of requests: ${JSON.stringify(perDriver)}` };
    }
    const c = (typeof b.capacity === "object" && b.capacity !== null ? b.capacity : null) as Record<string, unknown> | null;
    if (c === null || !isCapacityFigure(c.ladderRoster) || !isCapacityFigure(c.rung0Free) || !isCapacityFigure(c.ladderFree)) {
      return {
        ok: false,
        why: `BURST_PLAN burst ${n}'s capacity is not three counts of advisors (or null where unmeasured): ${JSON.stringify(b.capacity)}`,
      };
    }
    const prev = out[out.length - 1];
    if (prev && startAtMs <= prev.startAtMs) {
      return { ok: false, why: `BURST_PLAN burst ${n}'s moment is not after burst ${i}'s, so the bursts are not in time order` };
    }
    out.push({
      kind: kind as BurstKind,
      codes: [codes[0], codes[1]],
      shownTiers: [tiers[0] as string | null, tiers[1] as string | null],
      slot,
      startAtMs,
      perDriver,
      capacity: { ladderRoster: c.ladderRoster, rung0Free: c.rung0Free, ladderFree: c.ladderFree },
    });
  }
  // Every burst is numbered past the earlier bursts' shares (`burstRequestNumbers`), so
  // the shares' total is the request numbers one driver uses. Past the phone's digits
  // a request would have no number of its own, so it is refused here, by name, rather
  // than at a send that cannot build its lead (#3447).
  const total = out.reduce((n, b) => n + b.perDriver, 0);
  if (total > LEAD_REQUEST_NUMBERS) {
    return {
      ok: false,
      why:
        `BURST_PLAN's bursts total ${total} requests a driver, past the ${LEAD_REQUEST_NUMBERS} request numbers ` +
        `a load test phone holds (0 to ${LEAD_REQUEST_NUMBERS - 1}), so a burst request would have no number of its own`,
    };
  }
  return { ok: true, plan: { bursts: out } };
}

/**
 * The shared moment, far enough ahead that every driver is awake for it.
 *
 * The lead has to cover a runner being queued, checked out and installed, which is
 * the slowest part of the whole leg. Too short and drivers wake late, fire
 * nothing, and the judge fails the burst: the burst is cheap to re-run
 * and a ten minute run judged without its control is not.
 */
export function burstStartAt(nowMs: number, leadSeconds: number): number {
  return nowMs + Math.max(0, Math.round(leadSeconds)) * 1000;
}

/**
 * One driver's view of a bucket's offered times (#3348): the times, or null when they
 * have never been read, and when the view was last refreshed. An unread view is kept
 * like any other, so a refused first read is not asked again on every request.
 */
export interface SlotView {
  fetchedAtMs: number;
  slots: string[] | null;
}

/** Whether a view is recent enough to use without another read, at the refresh pace. */
export function slotViewIsFresh(view: SlotView | undefined, nowMs: number, refreshMs: number): boolean {
  return view !== undefined && nowMs - view.fetchedAtMs < refreshMs;
}

/**
 * The view after a read: the times it answered, else the last good times (a refused
 * or failed read keeps them, #2261), else unread. Always stamped now, so a failure is
 * paced like a success: four drivers share one 30 a minute ceiling, and a 429 asked
 * again at once is only another 429.
 */
export function slotViewAfterRead(view: SlotView | undefined, answered: string[] | null, nowMs: number): SlotView {
  return { fetchedAtMs: nowMs, slots: answered ?? view?.slots ?? null };
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
 * How many request numbers one driver has on one leg inside a load test phone's
 * digits (0 to 9999). Shared by the phone, which refuses a number past it, and by the
 * burst plan reader, which refuses shares that would number a request past it, so the
 * two can never disagree about the limit (L41).
 */
export const LEAD_REQUEST_NUMBERS = 10_000;

/**
 * A phone number of this attempt's OWN (#2261, #3447).
 *
 * The dedupe gate is a PERSON gate, and a weak match is email OR phone
 * (`src/lib/booking/person-dedupe.ts`): one phone matching is enough to answer
 * `confirm_required` and refuse the booking. Every driver once sent the same
 * `+15555550100`, so the first booking of a run succeeded and the rest would have
 * been refused as the same person calling again, which the judge would have read
 * as the booking path collapsing.
 *
 * The number is BUILT from the attempt, never hashed from its id (#3447). A hash
 * into ten million numbers collides by chance (about one run in sixty, at six
 * hundred attempts), and the 32 bit FNV-1a this used to keep did far worse on ids
 * differing only in their last digits: run 37547143303 gave twelve of driver 3's
 * requests the number of an earlier one, and all twelve were refused.
 *
 * So the seven digits are a run offset plus a local index:
 *
 *   local = leg * 10^6 + driver * 10^4 + n      (leg from LOADTEST_LEGS)
 *   digits = (offset(runId) + local) mod 10^7
 *
 * Within one run the local index is distinct for distinct attempts, and adding a
 * fixed offset modulo 10^7 is a bijection, so a run's numbers are distinct by
 * construction rather than by luck. The offset comes from the run id so a retried
 * attempt (a new `run_attempt`) on the same branch gets other numbers; two runs can
 * still meet by chance, which is why `reset.ts` deletes the bookings between arms.
 * A coordinate outside its digits is REFUSED by name: wrapping it would quietly
 * hand two attempts one number again.
 *
 * Kept in the 555 range, which is unassignable in the real numbering plan, so no
 * value this can produce is a number anybody actually holds.
 */
export function loadtestPhone(lead: LoadtestLead): string {
  const leg = (LOADTEST_LEGS as readonly string[]).indexOf(lead.leg);
  if (leg < 0 || leg > 9) throw new Error(`loadtestPhone: leg ${lead.leg} has no digit of its own`);
  if (!Number.isInteger(lead.driver) || lead.driver < 0 || lead.driver > 99) {
    throw new Error(`loadtestPhone: driver ${lead.driver} is outside 0 to 99`);
  }
  if (!Number.isInteger(lead.n) || lead.n < 0 || lead.n > LEAD_REQUEST_NUMBERS - 1) {
    throw new Error(`loadtestPhone: request ${lead.n} is outside 0 to ${LEAD_REQUEST_NUMBERS - 1}`);
  }
  const local = leg * 1_000_000 + lead.driver * 10_000 + lead.n;
  const digits = (runOffset(lead.runId) + local) % 10_000_000;
  return `+1555${String(digits).padStart(7, "0")}`;
}

/** Where a run's numbers start: FNV-1a of the run id, so a retried attempt starts elsewhere. */
function runOffset(runId: string): number {
  let h = 2166136261;
  for (let i = 0; i < runId.length; i++) {
    h ^= runId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 10_000_000;
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
export function idPrefix(runId: string, mode: DriverMode | "cold"): string {
  if (mode === "fault") return `${runId}-f`;
  // #3354: the diagnostic cold leg's bookings, apart from every driver's. Deliberately
  // inside the run's scope: the judge's checks on every booking (no two overlap on one
  // agent, each has an idempotency key and a busy block) must hold for these too, and a
  // cold booking that double booked would be a real fault. Its one reconciliation
  // against the drivers' files walks their attempts, not the rows, so these never read
  // as rows no driver accounts for.
  if (mode === "cold") return `${runId}-c`;
  // #3258: the baseline runs first on the same driver number, so it needs its own.
  if (mode === "baseline") return `${runId}-r`;
  if (mode === "burst") return `${runId}-b`;
  return runId;
}

/**
 * Which mode this driver runs, from its MODE. One outside the four is refused by
 * name rather than cast into one (it used to be a bare cast, and the dispatch runs
 * the steady pass for anything it does not recognise). Unset is the steady pass.
 */
export function readDriverMode(raw: string | undefined): { ok: true; mode: DriverMode } | { ok: false; why: string } {
  if (raw === undefined || raw === "") return { ok: true, mode: "steady" };
  if ((DRIVER_MODES as readonly string[]).includes(raw)) return { ok: true, mode: raw as DriverMode };
  return { ok: false, why: `MODE "${raw}" is not one of ${DRIVER_MODES.join(", ")}` };
}

/**
 * How late a burst driver may wake and still fire, from its `BURST_GRACE_MS` (#3446
 * review, L50). Unset or EMPTY is the default: the empty string is what a workflow
 * interpolates for a setting nobody created (L138), and `Number("")` is a grace of 0.
 * Anything that is not a whole, non negative number of milliseconds is refused by name:
 * `Number("soon")` is NaN, which a burst file writes as null and the judge reads as
 * "not recorded", so a bad setting would have been replaced by the default unseen.
 */
export function readBurstGraceMs(raw: string | undefined): { ok: true; ms: number } | { ok: false; why: string } {
  if (raw === undefined || raw.trim() === "") return { ok: true, ms: BURST_GRACE_DEFAULT_MS };
  const ms = Number(raw.trim());
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(ms)) {
    return { ok: false, why: `BURST_GRACE_MS "${raw}" is not a whole number of milliseconds` };
  }
  return { ok: true, ms };
}

/**
 * Work started now and awaited later, with its failure handled from the moment it is
 * created (#3446 review, L749). A promise that rejects before anything awaits it is
 * reported by Node as unhandled, which ends the process: a burst driver holding a
 * probe until every burst had fired lost every later burst to one failed write. The
 * returned promise never rejects; the failure goes to `onFailure`, for the caller to
 * report once it does await.
 */
export function settleLater(work: Promise<unknown>, onFailure: (err: unknown) => void): Promise<void> {
  return work.then(
    () => undefined,
    (err: unknown) => {
      onFailure(err);
    },
  );
}

/**
 * The header naming the run a booking API request belongs to (#3456), so the exact hourly
 * ceilings count this run alone. The load test Worker and the counter it binds are kept
 * between runs (#3310), and every driver books under one caller, so without it two runs or
 * arms inside an hour shared one count and a third could meet the 6,000 ceiling partway
 * through. `RUN_ID` is unique per dispatch and per attempt; a hand run that reuses one
 * shares that run's counts.
 */
export function loadtestRunHeaders(runId: string): Record<string, string> {
  return { [LOADTEST_RUN_HEADER]: runId };
}

/** The headers every confirm a driver sends carries: its leg (#3354) and its run (#3456). */
export function bookingRequestHeaders(apiKey: string, leg: LoadtestLeg, runId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    [LOADTEST_LEG_HEADER]: leg,
    ...loadtestRunHeaders(runId),
  };
}

/**
 * #3354: the body of one confirm, for every sender that drives the booking path (the
 * steady, burst, fault and baseline drivers, and the cold leg), so they all send the
 * same lead. Each carries its own external id, an address on the load test's own
 * domain and its OWN number (#2261): a weak dedupe match is email OR phone, so one
 * shared number makes every booking after the first a `confirm_required` refusal of
 * the same person calling again.
 */
export function bookingBody(req: {
  code: string;
  startIso: string;
  lead: LoadtestLead;
  timezone: string;
  /** #3495: the tier the code's availability answer had on show, handed back as the
   *  booker does; null or absent sends no key, and the confirm reads it instead. */
  shownTier?: string | null;
}): Record<string, unknown> {
  const externalId = leadExternalId(req.lead);
  return {
    bucketCode: req.code,
    start: req.startIso,
    timezone: req.timezone,
    externalId,
    attendee: {
      name: `Loadtest Lead ${externalId}`,
      email: `${externalId}@loadtest.local`,
      phone: loadtestPhone(req.lead),
    },
    ...(req.shownTier ? { shownTier: req.shownTier } : {}),
  };
}

/**
 * The tier an `/api/availability` answer had on show (#3495), or null when it named
 * none (a deployment before #3495, or a code with no tier), never a guess. Read beside
 * `offeredSlots` from the same answer, so a booking hands back the tier its times came
 * from.
 */
export function shownTierOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const tier = (body as { shownTier?: unknown }).shownTier;
  return typeof tier === "string" && tier.trim() !== "" ? tier : null;
}
