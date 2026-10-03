/**
 * The verdict on one booking path load run (#2244). Pure: no network, no clock,
 * no database. `scripts/test-judge-booking-run.ts` drives every bar with a fixture
 * per failure and a passing one.
 *
 * THE FIRST THING IT DOES IS REFUSE TO JUDGE AN INCOMPLETE RUN, and that is the
 * decision the whole file rests on. A judge handed three driver files out of four,
 * or a sampler that stopped after two minutes, can compute every rate below and
 * every one of them will look plausible: the p95 of a short run is lower, the
 * confirmed-per-minute of a missing driver is a quarter down, and nothing in the
 * numbers says which. A run that half happened must be reported as a run that half
 * happened, never as a run with a verdict (L288).
 */
import type { BookingAttempt, DriverResult } from "./book-plan.ts";
import { HEALTHY_INVOCATION_STATUS, type ScheduledReading } from "./platform-reading.ts";
import { CEILING_CONCLUSION, type CeilingVerdict } from "./preflight-checks.ts";
// Type-only (erased under --experimental-strip-types), so the judge never pulls
// the reader in at runtime and the two stay one direction apart.
import type { ConfirmStartupReading } from "./confirm-startup.ts";
import type { SoakSample } from "./invariants.ts";
import {
  faultLaneIncompleteness,
  judgeFaultLanes,
  type FaultLaneEvidence,
  type FaultLaneExpectations,
} from "./fault-lanes.ts";
import { everyTargetDegrades, parseFaultTargets } from "../../src/lib/loadtest-fault.ts";

/** A booking row the run created, as the judge needs it. */
export interface JudgedBooking {
  id: string;
  external_id: string | null;
  idempotency_key: string | null;
  assigned_user_id: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
}

/** What the platform's own analytics reported over the run's window. */
export interface PlatformReading {
  /**
   * Invocations the analytics API counted. It is the CONTROL: the run knows how
   * many requests it made, so a count far below that says the pipeline had not
   * caught up rather than that the Worker was idle, and the CPU and subrequest
   * numbers beside it are about a window that is not the one being judged.
   */
  invocations: number | null;
  cpuMsP99: number | null;
  /**
   * Subrequests summed over the window, or null when the window was not read.
   *
   * This field exists because what stood here before was wrong (#2279). The
   * comment said "Cloudflare's observability exposes NO subrequest counter, so a
   * subrequest bar could never be measured", and the report printed the same
   * claim. Measured against the live schema on 2026-09-13, `sum { subrequests }`
   * is a field, and the query was ALREADY asking for it before dropping it in the
   * response type (L425). Production returned 24,087 subrequests over 317
   * invocations.
   *
   * What is genuinely not exposed is a PER INVOCATION maximum, which is what the
   * 1000 subrequest ceiling is about, so this is reported as a mean and never made
   * a bar. The BREACH is still judged, because it arrives as a `status` other than
   * success.
   */
  subrequests: number | null;
  /**
   * The `status` histogram over the window.
   *
   * Named `statuses`, not `outcomes`, because `status` is what the dimension is
   * actually called. The old name went with a query asking for `dimensions {
   * outcome }`, which is not a field: the API answered 200 with an `errors` array
   * and null data on every single run, so this bar never once reached a reading
   * (#2279). The healthy value is `success`; the judge used to compare against
   * `ok`, which appears nowhere in the API's vocabulary.
   *
   * A CPU kill (`exceededCpu`) arrives here, which is the other way the platform
   * stops an invocation mid flight, and it is caught whether the invocation was a
   * request or a cron.
   */
  statuses: Record<string, number> | null;
  /**
   * The cron invocations inside the same window, read from the SEPARATE
   * `workersInvocationsScheduled` dataset, or null when it could not be read.
   *
   * Without this the CPU bar cannot honestly conclude either way.
   * `workersInvocationsAdaptive` counts cron invocations alongside fetch ones and
   * exposes no dimension telling them apart, and Slate's every minute lane runs to
   * a long CPU budget by design: production's adaptive p99 on 2026-09-13 was 48.9
   * SECONDS, which is the cron lanes, not the booking path. Judging that mixed
   * percentile against a per request budget would fail every run for a reason
   * nobody should fix (L36).
   */
  // `ScheduledReading` itself rather than a second copy of its shape: the inline
  // one shipped in #2352 and was already a field behind within the day, so the
  // judge could not see what its own reader had measured (L41).
  cron: ScheduledReading | null;
  /**
   * WHICH source the cron half above was actually read from (#2352).
   *
   * `workersInvocationsScheduled` filtered on a load test script name has never
   * once reported a tick: measured live on 2026-09-15 it held 61 rows for
   * production and ZERO for `slate-loadtest` while that Worker's lanes were
   * stamping every minute, and the run's own archived log held 19 scheduled
   * invocations. So a zero from that dataset is not a reading, and the judge may
   * only call a window empty when `agreed-empty` says two sources said so.
   */
  cronSource?: "platform" | "archive" | "agreed-empty" | null;
  /**
   * What a reader should know about how the cron half was arrived at, when there
   * is something: the dataset was blind and the log answered, or the dataset
   * refused. Null when the platform simply answered.
   */
  cronNote?: string | null;
  /**
   * Why the window could not be read, in the reader's own words, when it could
   * not be. Null on a reading that worked.
   */
  unreadableWhy?: string | null;
}

export interface JudgeInput {
  runId: string;
  target: { drivers: number; perDriverPerMinute: number; minutes: number };
  /** One per steady driver. Fewer than `target.drivers` is incomplete. */
  driverResults: DriverResult[];
  /** One per burst driver, or empty when the run had no burst leg. */
  burstResults: DriverResult[];
  /** One a minute for the whole window. */
  freshnessSamples: SoakSample[];
  /** Every booking the run created, read through a PAGINATING list. */
  bookings: JudgedBooking[];
  /** Booking ids that have at least one `busy_blocks` row. */
  bookingIdsWithBusyBlock: string[];
  /** Whether `bookings_active_slot_uniq` was seen to REFUSE a planted duplicate. */
  slotUniqueIndexPresent: boolean;
  /**
   * Whether `bookings_active_no_overlap` was seen to REFUSE a planted OVERLAP
   * (#2274).
   *
   * A separate flag because it is a separate guarantee, and the run's headline bar
   * rests on both. Uniqueness catches a second booking at the same START;
   * appointments are longer than the grid they are offered on (20 minutes every 10
   * in production), so adjacent offered times overlap and the second booking has a
   * DIFFERENT start, which uniqueness cannot see. A branch carrying one and not the
   * other produces a clean looking run that proves nothing about the half it lost.
   */
  overlapConstraintPresent: boolean;
  /**
   * The separate per address ceiling step, as its own verdict (#2275).
   *
   * The judge reads the CONCLUSION rather than re-deriving one from the counts, so
   * the control and the judge cannot disagree about what its numbers mean (L70,
   * L107). It used to take `{ sent, firstRefusedAt }` and decide for itself, and
   * the decision it reached was wrong in the one way that mattered: a control whose
   * every request was refused by the application read exactly like one that was
   * simply never throttled, and the run accused a ceiling that was working.
   */
  ipCeilingControl: CeilingVerdict;
  /**
   * The confirm path's own wall time split from the isolate's startup (#2340),
   * read from the run's archived log, or null when that archive carried no confirm
   * profile at all.
   *
   * Null rather than an empty reading, and a null FAILS its bar rather than
   * passing it, exactly as a ceiling control that never ran does. A run that could
   * not read its own archive did not prove anything about what a lead waits for,
   * and a bar nobody could measure must never render as one that passed (L98).
   */
  confirmStartup: ConfirmStartupReading | null;
  platform: PlatformReading;
  /**
   * The fault pass, when one ran. `faultTargets` is the list the DEPLOYMENT reported
   * failing (#3104), and decides which bar the pass is held to: with only systems
   * the request path degrades around it must not 5xx, and with one that fails loud
   * by design the 5xx count is a measurement of the percentage and is reported
   * instead. Empty means the driver never recorded it, which is incomplete.
   */
  faultPass?: { attempts: number; fiveXx: number; faultPct: number; faultTargets: string[] };
  /**
   * What the cron lanes did while the deployment was faulted (#3104): the lane
   * sampler's file, or null when it never arrived, and what the lanes are held to.
   * Present whenever the fault pass is; a fault pass without it is incomplete,
   * because the lanes are half of what the leg exists to show. `expectations` is a
   * `why` when what the lanes are held to could not be established (which lanes the
   * deployment runs), and that is incomplete too, never a crash or a pass.
   */
  faultLanes?: {
    evidence: FaultLaneEvidence | null;
    expectations: FaultLaneExpectations | { why: string };
  };
  /**
   * Which legs this run was CONFIGURED to have, so a leg that was asked for and
   * never arrived is incomplete rather than silently skipped (#2262).
   *
   * Required, so `tsc` names every construction site. Without it the burst bar was
   * gated on `burstResults.length > 0`, which cannot tell "this run had no burst
   * leg" from "the burst leg ran and its artifact never got here": the judge read
   * both as the first and published a report with its most important control
   * quietly absent (L98, L11). A hand run with no burst passes zeroes and the bars
   * are skipped exactly as before.
   */
  expectedLegs: { burstDrivers: number; faultPct: number; faultTargets?: readonly string[] };
  /**
   * The two CPU ceilings, which are different numbers about different things.
   * `cpuMsP99` is the REQUEST path budget (`REQUEST_CPU_P99_MS`, a share of the
   * latency bar) and applies only to a window with no cron in it; `cronCpuMs` is
   * the platform ceiling a scheduled invocation is killed at (`limits.cpu_ms` in
   * wrangler.jsonc). Neither is the LANE budget, which is about a scheduled tick
   * and belongs to the monitor lane rather than to this run (#2321).
   */
  budgets: { cpuMsP99: number; cronCpuMs: number };
}

export interface Finding {
  /** What was measured, in the words a reader acts on. */
  bar: string;
  detail: string;
}

export type JudgeVerdict = "pass" | "incomplete" | "unmeasured" | "fail";

/**
 * Every way the judge can end, each on its own code.
 *
 * `incomplete` and `unmeasured` are deliberately NOT failures and deliberately not
 * passes. One says the run did not happen as asked, the other says the platform
 * could not tell us what it did; both mean nobody learned whether the booking path
 * holds up, and reporting either as a pass or a failure is a claim the run cannot
 * support (L98, L11).
 */
export const JUDGE_EXIT = {
  pass: 0,
  incomplete: 2,
  unmeasured: 3,
  fail: 4,
} as const;

/** p50, p95 and max over a set of durations. Empty gives nulls, never zeros: a
 *  zero p95 reads as instant rather than as nothing measured. */
export function percentiles(values: number[]): { p50: number; p95: number; max: number } | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { p50: at(0.5), p95: at(0.95), max: s[s.length - 1]! };
}

/** Two windows overlap when each starts before the other ends: the half-open
 *  `[starts_at, ends_at)` comparison, so back-to-back calls do not read as a clash. */
export function overlaps(a: JudgedBooking, b: JudgedBooking): boolean {
  const as = Date.parse(a.starts_at);
  const ae = Date.parse(a.ends_at);
  const bs = Date.parse(b.starts_at);
  const be = Date.parse(b.ends_at);
  // An unreadable bound reads as OVERLAPPING, never as clear. This is the one
  // comparison in the file whose permissive answer would hide a double booking,
  // which is the worst thing this run can find (L50).
  if (![as, ae, bs, be].every(Number.isFinite)) return true;
  return as < be && bs < ae;
}

/** Statuses that hold a slot, so two of them on one agent at one time is a clash. */
const ACTIVE = new Set(["confirmed", "rescheduled", "completed"]);

function attemptsOf(results: DriverResult[]): BookingAttempt[] {
  return results.flatMap((r) => r.attempts);
}

/**
 * Why this run cannot be judged, or null.
 *
 * Checked BEFORE anything is computed, because every rate below is computable from
 * a partial run and every one of them looks plausible.
 */
export function incompleteness(input: JudgeInput): string[] {
  const why: string[] = [];
  const expectedPerDriver = input.target.perDriverPerMinute * input.target.minutes;

  if (input.driverResults.length !== input.target.drivers) {
    why.push(
      `${input.driverResults.length} driver result files, expected ${input.target.drivers}. ` +
        "A missing driver lowers every rate by a quarter and nothing in the numbers says so.",
    );
  }
  const seen = new Set(input.driverResults.map((r) => r.driver));
  if (seen.size !== input.driverResults.length) {
    why.push("two driver files claim the same driver number, so one driver's run is missing");
  }
  for (const r of input.driverResults) {
    if (r.runId !== input.runId) {
      why.push(`driver ${r.driver}'s file is from run ${r.runId}, not ${input.runId}`);
    }
    if (r.attempts.length !== expectedPerDriver) {
      why.push(
        `driver ${r.driver} recorded ${r.attempts.length} attempts, expected ${expectedPerDriver}`,
      );
    }
  }
  if (input.freshnessSamples.length !== input.target.minutes) {
    why.push(
      `${input.freshnessSamples.length} freshness samples, expected one a minute for ` +
        `${input.target.minutes} minutes. A short sample never reaches the age a full window does.`,
    );
  }
  // A burst driver that missed its moment is incomplete rather than failed: it
  // recorded nothing, so there is no contention to judge and "exactly one 200"
  // would be answered by however many drivers happened to arrive (L11).
  for (const b of input.burstResults) {
    if (b.burstSkipped) {
      why.push(
        `burst driver ${b.driver} did not fire (${b.burstSkipped}), so the burst was not simultaneous`,
      );
    }
  }
  // A leg the run was configured to have and did not get. Counted here rather than
  // left to the bar below, because the bar's own question ("was there exactly one
  // winner") cannot be asked of a leg whose file never arrived, and answering it
  // over nothing is how a missing control reads as a passing one.
  const wantBurst = input.expectedLegs.burstDrivers;
  if (wantBurst > 0 && input.burstResults.length !== wantBurst) {
    why.push(
      `${input.burstResults.length} burst driver files, expected ${wantBurst}. A burst judged on ` +
        `fewer drivers than fired is not the contention the control counts.`,
    );
  }
  const seenBurst = new Set(input.burstResults.map((b) => b.driver));
  if (seenBurst.size !== input.burstResults.length) {
    why.push("two burst driver files claim the same driver number, so one driver's burst is missing");
  }
  for (const b of input.burstResults) {
    if (b.runId !== input.runId) {
      why.push(`burst driver ${b.driver}'s file is from run ${b.runId}, not ${input.runId}`);
    }
    if (!b.burstSkipped && b.attempts.length !== b.planned) {
      why.push(
        `burst driver ${b.driver} fired ${b.attempts.length} of ${b.planned} planned requests, so ` +
          `the burst was smaller than the one being judged`,
      );
    }
  }
  const wantFault = input.expectedLegs.faultPct;
  if (wantFault > 0) {
    if (!input.faultPass) {
      why.push(
        `the run was configured with a fault pass at ${wantFault} percent and no fault result ` +
          `arrived, so the bar was never asked`,
      );
    } else if (input.faultPass.faultPct !== wantFault) {
      // The deployment's own reading, not the job's intention. A pass driven
      // against a deployment running a DIFFERENT percentage measured something
      // nobody configured, and zero is the case that matters: it answers every
      // request perfectly and satisfies the bar with no fault ever injected.
      why.push(
        `the fault pass ran against a deployment reporting ${input.faultPass.faultPct} percent, ` +
          `not the ${wantFault} it was configured for`,
      );
    }
  }
  // WHICH systems failed (#3104). The bar the pass is held to depends on it, so a
  // pass whose deployment faulted different systems from the ones asked for would be
  // judged against the wrong bar, and one that never recorded them cannot be judged
  // against any.
  if (input.faultPass) {
    const got = [...new Set(input.faultPass.faultTargets)].sort();
    if (got.length === 0) {
      why.push(
        "the fault driver did not record which systems the deployment was failing, so which bar " +
          "the pass is held to cannot be decided",
      );
    } else if (wantFault > 0) {
      const want = [...new Set(input.expectedLegs.faultTargets ?? parseFaultTargets(undefined).targets)].sort();
      if (want.join(",") !== got.join(",")) {
        why.push(
          `the fault pass ran against a deployment failing ${got.join(", ")}, not the ` +
            `${want.join(", ")} it was configured for`,
        );
      }
    }
    if (!input.faultLanes || input.faultLanes.evidence === null) {
      why.push(
        "the fault pass ran and no lane sampler file arrived, so what the cron lanes did while " +
          "faults were injected was never measured",
      );
    } else if ("why" in input.faultLanes.expectations) {
      why.push(input.faultLanes.expectations.why);
    } else {
      for (const w of faultLaneIncompleteness(input.faultLanes.evidence, input.faultLanes.expectations)) {
        why.push(w);
      }
    }
  }
  return why;
}

/** What the run measured, once it is known to be complete. */
export interface RunMeasurements {
  attempts: number;
  confirmed: number;
  confirmedPerMinute: number;
  targetPerMinute: number;
  outcomes: Record<string, number>;
  /** Over EVERY response, whatever its status. */
  all: ReturnType<typeof percentiles>;
  /** Over the 200s alone, which is what the latency bar is about. */
  ok: ReturnType<typeof percentiles>;
  fiveXx: number;
  /** Requests that never got a reply at all, kept apart from a 5xx. */
  noReply: number;
  writeRefusals: number;
  /** Write refusals grouped by the address Slate said it saw. */
  refusalsByIp: Record<string, number>;
  freshnessMaxSec: number;
  /**
   * Active bookings the overlap counts below are OVER (#2323).
   *
   * The denominator, so a zero cannot be read as a run that looked at nothing. A
   * measured zero and a check that never ran render the same when neither prints a
   * count (L98).
   */
  activeBookings: number;
  /**
   * Pairs of active bookings that overlap on one agent: the number this whole run
   * exists to produce after #2274, reported on EVERY run rather than only when it
   * is not zero.
   *
   * Every pair, not only adjacent ones after a sort: three mutually overlapping
   * bookings are three pairs, and a number printed as a measurement has to be the
   * number (L63).
   */
  overlappingPairs: number;
  /**
   * Pairs sharing an exact start on one agent, which is the narrower thing
   * `bookings_active_slot_uniq` protects. Reported beside the overlap count
   * because the gap between them is the whole of #2274: appointments are longer
   * than the grid they are offered on, so adjacent offered times overlap and
   * uniqueness cannot see them.
   */
  sameSlotPairs: number;
  /**
   * The confirm path's two halves, reported apart (#2340).
   *
   * Null where nothing was measured, never zero: a run whose archive never arrived
   * and a confirm that cost nothing would otherwise read the same.
   *
   * `confirmHandler` is the confirm's OWN wall time, from the profile it logs.
   * The startup pair is everything before that profile started, split by whether
   * the isolate became ready inside that very request. The cold one is what a lead
   * unlucky enough to be first on an isolate waits through before the booking
   * begins; the warm one is the framework's per request overhead.
   */
  confirmSamples: number | null;
  confirmCold: number | null;
  confirmHandler: ReturnType<typeof percentiles>;
  confirmColdStartup: ReturnType<typeof percentiles>;
  confirmWarmStartup: ReturnType<typeof percentiles>;
  /**
   * What the invocation went on doing AFTER the booking was written and the
   * response sent, which on this path is the webhook send deferred by #884.
   *
   * No lead waits for it, and it is still charged to the invocation the CPU bar
   * reads, which is why it is reported beside that bar rather than folded into it.
   */
  confirmAfterResponse: ReturnType<typeof percentiles>;
}

/**
 * Every overlapping pair, and every same slot pair, per agent (#2323).
 *
 * Exported so the judge's finding and the report's measured line are ONE
 * computation: a count printed beside a finding that was computed differently is
 * two answers to one question (L41).
 */
export function overlapCounts(bookings: readonly JudgedBooking[]): {
  activeBookings: number;
  overlappingPairs: number;
  sameSlotPairs: number;
  /** The clashing pairs, for the finding to name. */
  clashes: string[];
} {
  const byAgent = new Map<string, JudgedBooking[]>();
  let activeBookings = 0;
  for (const b of bookings) {
    if (!ACTIVE.has(b.status) || !b.assigned_user_id) continue;
    activeBookings += 1;
    const list = byAgent.get(b.assigned_user_id) ?? [];
    list.push(b);
    byAgent.set(b.assigned_user_id, list);
  }
  const clashes: string[] = [];
  let sameSlotPairs = 0;
  for (const [agent, list] of byAgent) {
    // Every pair, compared directly. Sorting and checking neighbours detects an
    // overlap correctly and UNDERCOUNTS it, and the sort would also be ordered by
    // a raw `Date.parse` that is NaN for an unreadable bound.
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (!overlaps(list[i]!, list[j]!)) continue;
        clashes.push(`${agent}: ${list[i]!.id} and ${list[j]!.id}`);
        if (list[i]!.starts_at === list[j]!.starts_at) sameSlotPairs += 1;
      }
    }
  }
  return { activeBookings, overlappingPairs: clashes.length, sameSlotPairs, clashes };
}

export function measure(input: JudgeInput): RunMeasurements {
  const attempts = attemptsOf(input.driverResults);
  const outcomes: Record<string, number> = {};
  for (const a of attempts) {
    const key = a.status === 200 ? (a.outcome ?? "ok") : `${a.status} ${a.outcome ?? ""}`.trim();
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }
  const refusalsByIp: Record<string, number> = {};
  for (const a of attempts) {
    if (a.status !== 429) continue;
    // An attempt with no echoed address is counted under a NAMED bucket rather
    // than dropped: a run whose echo header never arrived would otherwise report
    // no refusals at all and read as never having met the ceiling.
    const ip = a.seenIp ?? "(not echoed)";
    refusalsByIp[ip] = (refusalsByIp[ip] ?? 0) + 1;
  }
  const confirmed = attempts.filter((a) => a.status === 200).length;
  return {
    attempts: attempts.length,
    confirmed,
    confirmedPerMinute: input.target.minutes === 0 ? 0 : confirmed / input.target.minutes,
    targetPerMinute: input.target.drivers * input.target.perDriverPerMinute,
    outcomes,
    all: percentiles(attempts.map((a) => a.wallMs)),
    ok: percentiles(attempts.filter((a) => a.status === 200).map((a) => a.wallMs)),
    fiveXx: attempts.filter((a) => a.status >= 500).length,
    noReply: attempts.filter((a) => a.status === 0 && a.outcome !== "no-slots-offered").length,
    writeRefusals: attempts.filter((a) => a.status === 429).length,
    refusalsByIp,
    freshnessMaxSec: Math.max(0, ...input.freshnessSamples.map((s) => s.maxAgeSec)),
    ...(({ activeBookings, overlappingPairs, sameSlotPairs }) => ({
      activeBookings,
      overlappingPairs,
      sameSlotPairs,
    }))(overlapCounts(input.bookings)),
    confirmSamples: input.confirmStartup?.samples ?? null,
    confirmCold: input.confirmStartup?.cold ?? null,
    confirmHandler: percentiles(input.confirmStartup?.handlerMs ?? []),
    confirmColdStartup: percentiles(input.confirmStartup?.coldPreProfileMs ?? []),
    confirmWarmStartup: percentiles(input.confirmStartup?.warmPreProfileMs ?? []),
    confirmAfterResponse: percentiles(input.confirmStartup?.afterProfileMs ?? []),
  };
}

/** The bars, in the order a reader should meet them. */
export const CONFIRMED_RATE_FLOOR = 0.8;
export const OK_P95_MS = 5000;
/**
 * The share of the latency bar the REQUEST path may spend on CPU alone (#2321).
 *
 * CPU is the compute floor under wall time, so a confirm burning more than half
 * the latency bar on CPU has no headroom left for the database and Google round
 * trips it also has to make: the latency bar is about to fail for a cause this one
 * can NAME first, which is the whole reason to judge CPU separately at all.
 */
export const REQUEST_CPU_LATENCY_SHARE = 0.5;
/**
 * The REQUEST path's own CPU budget, derived rather than written twice (L41).
 *
 * It used to borrow `CPU_BUDGET_MS`, defaulting to 200ms, which is the LANE budget
 * for a scheduled invocation on the shared every minute tick. The two are
 * different questions: the lane budget is about a cron tick and its real ceiling
 * is `limits.cpu_ms` (120,000ms), which the cron half of this bar already judges
 * against, while this one is about a lead waiting and about spend on a path
 * Cloudflare scales horizontally. The 200 itself was never derived for either: it
 * is production's MIXED p50 of 198ms measured on 2026-09-13, a reading about
 * whatever traffic that hour held (L107).
 *
 * Measured against it on 2026-09-14 (run 34862015419): CPU p99 4,908ms over 1,364
 * invocations with no cron in the window, against a wall p95 of 4,025ms. CPU
 * roughly equals wall, so the confirm path is compute bound rather than waiting on
 * anything, and #2321 holds the open question of where those seconds go.
 *
 * What it is NOT (#2345): a share of what a lead waits for. The platform reports one
 * CPU figure per INVOCATION, and a confirm's invocation outlives its response by
 * whatever was deferred to after it (the tally, and since #2345 the booked bucket's
 * slot refresh under its own name), so the percentile this is judged against counts
 * work no lead waits on and cannot be split. The derivation from the latency bar is
 * the budget's reason, not a claim about what the reading measures; read the report's
 * by job line beside any breach.
 */
export const REQUEST_CPU_P99_MS = Math.round(OK_P95_MS * REQUEST_CPU_LATENCY_SHARE);
/**
 * What a lead may wait BEFORE the confirm starts (#2340).
 *
 * The rest of the latency bar, derived rather than picked: the confirm may spend
 * up to `REQUEST_CPU_LATENCY_SHARE` of it on its own compute, so everything in
 * front of it has to fit the remainder for a lead on a cold isolate to stay inside
 * the same bar as everybody else. The two together are exactly `OK_P95_MS`, which
 * is the point: they are one budget split in two, not two numbers picked apart.
 *
 * Measured against it on 2026-09-14 (run 34889873261): 3,063ms median and 4,598ms
 * max on the 32 confirms that cost over two seconds of CPU, against about 500ms on
 * the 409 that cost under half a second. The expensive ones were not doing more
 * confirm work; their stage profiles are the same shape.
 */
export const REQUEST_STARTUP_P95_MS = OK_P95_MS - REQUEST_CPU_P99_MS;
/**
 * The share of the scheduled CPU kill limit a cron tick may reach before the cron
 * half of the CPU bar fails (#2357).
 *
 * The bar used to fail only past the limit itself, so run 34991614423 passed a
 * minute tick at 119,137ms against 120,000ms in the same words it would have used
 * for 4,000. A tick killed there dies mid lane with no retry (cron has none), and
 * that run was one slow agent away from it. Half leaves room for the worst tick to
 * double before the platform kills it, which is the measured trend on this roster
 * shape: 27s, then 65.6s, then 119s across three consecutive runs.
 */
export const CRON_CPU_MARGIN_SHARE = 0.5;

/**
 * The worst tick's share of the kill limit, in ONE wording for the report line
 * and the finding (L41), so 3 percent and 99 percent never read alike.
 */
export function cronCpuShareText(worstCpuMs: number, ceilingMs: number): string {
  const worst = Math.round(worstCpuMs);
  if (!Number.isFinite(ceilingMs) || ceilingMs <= 0) {
    return `worst tick ${worst}ms of CPU, against an unreadable kill limit`;
  }
  return `worst tick ${worst}ms of CPU, ${Math.floor((worstCpuMs / ceilingMs) * 100)}% of the ${ceilingMs}ms kill limit`;
}
export const FRESHNESS_MAX_SEC = 6 * 60;
/** How far the platform's invocation count may sit below the run's own before its
 *  numbers are about a different window. */
export const INVOCATION_CONTROL_FLOOR = 0.5;

export interface JudgeResult {
  verdict: JudgeVerdict;
  exit: number;
  findings: Finding[];
  measurements: RunMeasurements | null;
  incomplete: string[];
}

/**
 * Whether a fault pass is held to "no 5xx" (#3104).
 *
 * Only when every system it failed is one the request path degrades around
 * (`FAULT_TARGET_CONTRACT`). With a database fault or a failing calendar write in
 * the mix, a 5xx is the designed answer (the booking could not be written, the event
 * does not exist), so the count measures the percentage rather than the code and
 * barring it would make the bar unreachable for a reason nobody should fix (#2241).
 * The count is still reported; what is judged on such a pass is the cron lanes.
 * A name the shared vocabulary does not know keeps the bar, the strict direction.
 */
export function faultPassKeepsFiveXxBar(targets: readonly string[]): boolean {
  const parsed = parseFaultTargets(targets.join(","));
  if (parsed.unknown.length > 0) return true;
  return everyTargetDegrades(parsed.targets);
}

export function judgeBookingRun(input: JudgeInput): JudgeResult {
  const incomplete = incompleteness(input);
  if (incomplete.length > 0) {
    return {
      verdict: "incomplete",
      exit: JUDGE_EXIT.incomplete,
      findings: [],
      measurements: null,
      incomplete,
    };
  }

  const m = measure(input);
  const findings: Finding[] = [];
  const fail = (bar: string, detail: string) => findings.push({ bar, detail });

  // --- throughput -------------------------------------------------------------
  const floor = m.targetPerMinute * CONFIRMED_RATE_FLOOR;
  if (m.confirmedPerMinute < floor) {
    fail(
      "confirmed bookings per minute",
      `${m.confirmedPerMinute.toFixed(1)} a minute against a target of ${m.targetPerMinute} ` +
        `(floor ${floor.toFixed(1)}). Outcome mix: ${JSON.stringify(m.outcomes)}`,
    );
  }

  // --- latency ----------------------------------------------------------------
  if (m.ok === null) {
    fail("latency of successful bookings", "not one request succeeded, so there is no p95 to judge");
  } else if (m.ok.p95 > OK_P95_MS) {
    fail(
      "latency of successful bookings",
      `p95 ${m.ok.p95}ms over the ${OK_P95_MS}ms bar (p50 ${m.ok.p50}ms, max ${m.ok.max}ms)`,
    );
  }
  // 5xx and no-reply are reported separately and BOTH fail. A request the
  // deployment answered badly and one it never answered send two different people
  // to two different places (L11).
  if (m.fiveXx > 0) fail("server errors", `${m.fiveXx} responses were 5xx`);
  if (m.noReply > 0) fail("unanswered requests", `${m.noReply} requests got no reply at all`);

  // --- the invariant the whole run exists to protect --------------------------
  // BOTH guards, reported separately: they send a reader to two different
  // migrations, and one message answering for the other is how somebody looks in
  // the wrong place (L11).
  if (!input.slotUniqueIndexPresent) {
    fail(
      "bookings_active_slot_uniq",
      "the index that makes two bookings on one agent at the SAME TIME impossible is NOT enforcing " +
        "on the branch, so an absence of overlaps below proves nothing about production",
    );
  }
  if (!input.overlapConstraintPresent) {
    fail(
      "bookings_active_no_overlap",
      "the constraint that makes two OVERLAPPING bookings on one agent impossible is NOT enforcing " +
        "on the branch. Appointments are longer than the grid they are offered on, so adjacent " +
        "offered times overlap and uniqueness cannot see them: an absence of overlaps below " +
        "proves nothing about the case this run exists to find",
    );
  }
  // The SAME computation the measured section prints, so the finding and the
  // reported count can never be two answers to one question (L41).
  const { clashes } = overlapCounts(input.bookings);
  if (clashes.length > 0) {
    fail(
      "double bookings",
      `${clashes.length} pairs of active bookings overlap on one agent: ${clashes.slice(0, 5).join("; ")}`,
    );
  }

  // --- every 200 left a row behind --------------------------------------------
  const bookedIds = new Set(input.bookings.map((b) => b.external_id ?? ""));
  const missingRow = attemptsOf(input.driverResults).filter(
    (a) => a.status === 200 && !bookedIds.has(a.externalId),
  );
  if (missingRow.length > 0) {
    fail(
      "a 200 with no booking row",
      `${missingRow.length} requests were answered 200 and no booking carries their external id ` +
        `(first: ${missingRow[0]!.externalId})`,
    );
  }
  const noKey = input.bookings.filter((b) => !b.idempotency_key);
  if (noKey.length > 0) {
    fail("idempotency key", `${noKey.length} booking rows carry no idempotency key`);
  }
  const withBlock = new Set(input.bookingIdsWithBusyBlock);
  const noBlock = input.bookings.filter((b) => ACTIVE.has(b.status) && !withBlock.has(b.id));
  if (noBlock.length > 0) {
    fail(
      "busy_blocks write-through",
      `${noBlock.length} active bookings have no busy_blocks row, so their slot still reads free`,
    );
  }

  // --- the burst --------------------------------------------------------------
  if (input.burstResults.length > 0) {
    const burst = attemptsOf(input.burstResults);
    const won = burst.filter((a) => a.status === 200);
    // The invariant is ONE WINNER PER AGENT, not one winner (#2261).
    //
    // "Exactly one" was a proxy for the burst code's pool being one agent deep,
    // which the seed does not guarantee and did not deliver: the first real run
    // answered TWO 200s at one slot, and they went to two DIFFERENT agents, which
    // is `bookings_active_slot_uniq` working exactly as specified. A bar that
    // failed on it would be red for a property of the roster rather than for
    // anything the booking path did, which is how a check stops being read (L36).
    //
    // What the index actually promises is that no AGENT holds two active bookings
    // at one slot, so that is what is asked. It is the stronger reading as well as
    // the truer one: at a pool of one it is the original control unchanged, and at
    // any depth it still catches the double booking the control existed to find.
    const agentOf = new Map(input.bookings.map((b) => [b.external_id ?? "", b.assigned_user_id]));
    const winningAgents = won.map((a) => agentOf.get(a.externalId) ?? null);
    const namedAgents = winningAgents.filter((id): id is string => id !== null);
    const distinct = new Set(namedAgents);
    if (won.length === 0) {
      fail(
        "the burst",
        `none of the ${burst.length} burst requests was answered 200, so the slot was already ` +
          "taken before the burst fired and nothing about contention was measured",
      );
    } else if (distinct.size < namedAgents.length) {
      fail(
        "the burst's winners",
        `${won.length} of ${burst.length} burst requests were answered 200 and they resolve to ` +
          `only ${distinct.size} agent(s), so an agent holds two active bookings at one slot`,
      );
    } else if (namedAgents.length < won.length) {
      fail(
        "the burst's winners",
        `${won.length - namedAgents.length} of the ${won.length} burst requests answered 200 have ` +
          "no booking row naming an agent, so the SLOT_TAKEN answers point at nothing",
      );
    }
    const taken = burst.filter((a) => a.status === 409 && a.outcome === "SLOT_TAKEN");
    const otherRefusals = burst.filter((a) => a.status !== 200 && a.outcome !== "SLOT_TAKEN");
    if (otherRefusals.length > 0) {
      fail(
        "the burst's losers",
        `${otherRefusals.length} burst requests were refused for a reason other than the slot being ` +
          `taken (${[...new Set(otherRefusals.map((a) => `${a.status} ${a.outcome}`))].join(", ")})`,
      );
    }
    // `taken` is read for the count above and deliberately not asserted on
    // separately: every non-winner is already required to be SLOT_TAKEN by the
    // `otherRefusals` bar, and whether each winner has a booking row is what the
    // agent lookup above measures.
    void taken;
  }

  // --- freshness --------------------------------------------------------------
  if (m.freshnessMaxSec > FRESHNESS_MAX_SEC) {
    fail(
      "recompute freshness under load",
      `the oldest bucket reached ${m.freshnessMaxSec}s, over the ${FRESHNESS_MAX_SEC}s bar`,
    );
  }

  // --- the per address ceiling, proved by its own step ------------------------
  //
  // One branch, because the control already classified itself. Every non passing
  // conclusion carries its OWN sentence, so a ceiling that is off, a control whose
  // requests the app refused, a rejected key and a step that never ran each send a
  // reader somewhere different (L11).
  const c = input.ipCeilingControl;
  if (c.conclusion !== CEILING_CONCLUSION.applies) {
    fail("the per address write ceiling", c.detail);
  }

  // --- what a lead waits for before the confirm even starts (#2340) -----------
  //
  // Read from the run's OWN archived log rather than from the analytics pipeline,
  // so it sits here with the other bars that depend on nothing but this run, above
  // the one section that depends on somebody else's pipeline.
  //
  // It exists because the platform's CPU percentile cannot separate the two: it is
  // one number per invocation with nothing in it saying whether that invocation
  // also paid for the isolate. Run 34889873261 failed the CPU bar with a p99 of
  // 2,988ms, and the confirms behind that number were not doing more confirm work.
  const cs = input.confirmStartup;
  if (cs === null) {
    // The same reading as a ceiling control that never ran. A bar nobody could
    // measure must never render as one that passed (L98), and the detail names the
    // artifact rather than the product, because that is what a reader has to fix.
    fail(
      "confirm startup",
      "the run's archived log carried no confirm profile, so the confirm's own time and the " +
        "isolate's startup could not be told apart and nothing is claimed about either. The " +
        "profile is written under SLATE_LOADTEST only, and the judge reads results/tail.jsonl",
    );
  } else if (cs.samples === 0) {
    // The archive arrived and held no confirm profile this could read. Its own
    // sentence, because it sends a reader to a different place than a missing file
    // does: the stream is truncated, or the lines are there and unreadable (L11).
    fail(
      "confirm startup",
      `the archived log held no readable confirm profile (${cs.unreadable} carried one this could ` +
        `not read, ${cs.unparsable} lines were not readable JSON at all), so the confirm's own ` +
        "time and the isolate's startup could not be told apart. The archive is written by a " +
        "`wrangler tail` under a timeout, so its last line is routinely half written",
    );
  } else if (cs.cold === 0) {
    // Nothing to judge, which is never a pass (L98). Measured on 2026-09-14, 32 of
    // 757 confirms were the first on their isolate, so zero over a full run is the
    // shape of a broken reading rather than of a run that got lucky.
    fail(
      "confirm startup",
      `none of the ${cs.samples} confirms read was the first on its isolate, so what a lead ` +
        "landing on a cold one waits for was not measured. A ten minute run spins up dozens of " +
        "isolates, so zero is the shape of a reading that broke rather than of a lucky run",
    );
  } else if (m.confirmColdStartup !== null && m.confirmColdStartup.p95 > REQUEST_STARTUP_P95_MS) {
    fail(
      "confirm startup",
      `a lead landing on a cold isolate waited p95 ${m.confirmColdStartup.p95}ms (max ` +
        `${m.confirmColdStartup.max}ms) before the confirm began, over the ` +
        `${REQUEST_STARTUP_P95_MS}ms left of the ${OK_P95_MS}ms latency bar once the confirm's ` +
        `own share is taken out. That is the server bundle being evaluated, charged in full to ` +
        `whichever request the isolate served first: ${cs.cold} of ${cs.samples} confirms here, ` +
        `against ${m.confirmWarmStartup === null ? "no" : `p95 ${m.confirmWarmStartup.p95}ms`} ` +
        "on a warm one. The confirm itself is judged separately",
    );
  }

  // --- the fault pass ---------------------------------------------------------
  if (input.faultPass) {
    if (input.faultPass.attempts === 0) {
      fail(
        "the fault pass",
        `it was configured at ${input.faultPass.faultPct} percent and made no requests, so it ` +
          "proved nothing",
      );
    } else if (input.faultPass.fiveXx > 0 && faultPassKeepsFiveXxBar(input.faultPass.faultTargets)) {
      fail(
        "the fault pass",
        `${input.faultPass.fiveXx} of ${input.faultPass.attempts} requests were 5xx with ` +
          `${input.faultPass.faultTargets.join(", ")} failing ${input.faultPass.faultPct} percent of ` +
          "calls; the path must degrade, not error",
      );
    }
    // The cron lanes, judged rather than read by a person (#3104). Incompleteness
    // above has already refused a run whose lane evidence is missing or has holes.
    const x = input.faultLanes?.expectations;
    if (input.faultLanes?.evidence && x && !("why" in x)) {
      for (const f of judgeFaultLanes(input.faultLanes.evidence, x)) {
        fail(f.bar, f.detail);
      }
    }
  }


  // The fault pass is judged BEFORE the platform read, and the ordering is load
  // bearing (#2261). The platform section is the only one that can RETURN early,
  // and while this sat below it an unreadable analytics window skipped this bar
  // entirely: the first real run answered three 500s under fault and the report
  // never mentioned them. Anything measurable from the run's OWN files belongs
  // above the one check that depends on somebody else's pipeline.
  // --- the platform's own numbers ---------------------------------------------
  const p = input.platform;
  const expectedInvocations = m.attempts;
  if (p.invocations === null || p.cpuMsP99 === null || p.statuses === null) {
    return unmeasured(
      m,
      // The CALLER's own sentence when it has one. This bar spent its whole life
      // printing a generic line about a window it had never successfully queried,
      // and the one fact that would have identified the fault in a single reading
      // was the API's own refusal text (L11).
      p.unreadableWhy ?? "the analytics API did not report CPU, statuses or invocations for the window",
      findings,
    );
  }
  if (p.invocations < expectedInvocations * INVOCATION_CONTROL_FLOOR) {
    // The CONTROL. A count far under what the run itself made says the pipeline
    // had not caught up (it has lagged three hours), so the CPU and subrequest
    // numbers beside it describe a window that is not this one. Reported as
    // unmeasured rather than as a pass, because a low reading from a lagging
    // pipeline looks exactly like a cheap run (#1533, L98).
    return unmeasured(
      m,
      `the analytics API counted ${p.invocations} invocations against the ${expectedInvocations} ` +
        "this run made, so its CPU and subrequest numbers are about a different window",
      findings,
    );
  }
  // --- CPU, judged only where the reading is attributable ----------------------
  //
  // The per request budget may be applied to the adaptive percentile ONLY when no
  // cron fired inside the window, because that is the one case where the
  // percentile is request only. `workersInvocationsAdaptive` counts scheduled
  // invocations alongside fetch ones and carries no dimension separating them, and
  // Slate's every minute lane runs to a long CPU budget deliberately: production's
  // adaptive p99 on 2026-09-13 was 48.9 seconds against a 200ms per request
  // budget, entirely because of the crons in the window. Applying the budget
  // regardless would make this bar fail every run for a reason nobody should fix,
  // which is how a bar stops being read (L36), and it would have done exactly that
  // the moment the query was repaired.
  if (p.cron === null) {
    // Not a pass. The request half cannot be attributed without knowing whether
    // crons ran, and a reading nobody can attribute is not a measurement (L98).
    return unmeasured(
      m,
      "the scheduled invocations could not be read, so the CPU reading cannot be told " +
        "apart from the cron lanes and nothing is claimed about it",
      findings,
    );
  }
  if (p.cron.invocations === 0) {
    // A zero is only a reading when TWO sources said so (#2352). The analytics
    // dataset alone has never once reported a tick for a load test Worker, so its
    // zero is the reader being blind, and taking it for an empty window is what
    // let the per request budget be applied to a window full of cron lanes and
    // the conclusion written into a report. The judge asks rather than trusting
    // its caller, so a construction site that forgets to say cannot quietly
    // restore the old behaviour (L96).
    if (p.cronSource !== "agreed-empty") {
      return unmeasured(
        m,
        p.cronNote ??
          "the cron half reported zero scheduled invocations without a second source agreeing, " +
            "so nothing can say whether a cron fired and the CPU reading cannot be attributed",
        findings,
      );
    }
    if (p.cpuMsP99 > input.budgets.cpuMsP99) {
      // The split is NAMED in the finding, because this percentile counts the
      // isolate's startup as the confirm's own compute and a reader sent to
      // optimise the confirm would be looking at the wrong half (#2340).
      const split =
        cs === null
          ? " The startup split could not be read from this run's archive, so how much of this " +
            "is the confirm and how much is the isolate starting up is unknown"
          : ` Of ${cs.samples} confirms read from this run's log: ` +
            `${m.confirmColdStartup === null ? "an unmeasured time" : `p95 ${m.confirmColdStartup.p95}ms`} ` +
            `before the confirm began (${cs.cold} were the first on their isolate), ` +
            `${m.confirmHandler === null ? "an unmeasured time" : `p95 ${m.confirmHandler.p95}ms`} ` +
            `inside it, and ${m.confirmAfterResponse === null ? "an unmeasured time" : `p95 ${m.confirmAfterResponse.p95}ms`} ` +
            "AFTER the response had gone, the work deferred to after the response; the report's " +
            "by job line says which job it was (#2345: on the load test Worker it is never the " +
            "webhook send, which has no subscriber there). No lead waits for " +
            "that last span and this percentile still counts it, so read the three apart before " +
            "optimising anything. The percentile CANNOT be split: the runtime reports one CPU " +
            "figure per invocation, and no in process timer can apportion it, because a Worker's " +
            "clock returns the time of the last I/O and does not advance during execution. The " +
            "report's per job line beside it is WALL, measured the same way and subject to the " +
            "same limit";
      fail(
        "Worker CPU on the request path",
        `p99 ${p.cpuMsP99}ms of CPU per invocation, over the ${input.budgets.cpuMsP99}ms request ` +
          "budget, with no cron in the window on BOTH the analytics dataset and this run's own " +
          "archived log, so this IS the request path. That budget is a " +
          `share of the ${OK_P95_MS}ms latency bar, not the lane budget: CPU cannot exceed wall ` +
          "time, so a confirm spending this much of it on compute has no headroom left for the " +
          "database and Google round trips it also has to make." +
          split,
      );
    }
  } else if (p.cron.worstCpuMs > input.budgets.cronCpuMs * CRON_CPU_MARGIN_SHARE) {
    // The cron half IS judgeable exactly, because the scheduled dataset reports one
    // row per invocation with its own CPU and the cron expression that fired it, so
    // the finding can NAME the lane rather than pointing at a percentile.
    //
    // Judged against a MARGIN below the kill limit (#2357), not the limit itself:
    // a tick that survived by under a second is a near miss, not a pass.
    const worst = Object.entries(p.cron.byCron).sort((a, b) => b[1].worstCpuMs - a[1].worstCpuMs)[0];
    const marginMs = Math.round(input.budgets.cronCpuMs * CRON_CPU_MARGIN_SHARE);
    fail(
      "cron CPU",
      `the "${worst?.[0] ?? "(unnamed)"}" lane's ${cronCpuShareText(p.cron.worstCpuMs, input.budgets.cronCpuMs)}, ` +
        `past the ${marginMs}ms margin (${Math.round(CRON_CPU_MARGIN_SHARE * 100)}% of it) this bar ` +
        "holds. A tick killed at the limit dies mid lane with no retry, so the margin is the " +
        "bar and the limit is not",
    );
  }
  // Every status other than `success` is a finding, and they are named rather than
  // summed: `exceededCpu` (Cloudflare killed the invocation mid flight),
  // `exceededMemory` and a subrequest breach each mean a different thing to fix,
  // and a single "N invocations exceeded a limit" would send one person to look at
  // three different problems (L11). This is also what catches a CPU breach on
  // EITHER kind of invocation, without needing to tell them apart.
  const bad = Object.entries(p.statuses).filter(([s]) => s !== HEALTHY_INVOCATION_STATUS);
  for (const [status, n] of bad) {
    if (n > 0) {
      fail(
        "platform outcome",
        `${n} invocations ended as ${status} rather than ${HEALTHY_INVOCATION_STATUS}`,
      );
    }
  }
  if (Object.keys(p.statuses).length === 0) {
    // An empty histogram is not "every invocation was fine": it is a reading that
    // found nothing, and the control above cannot catch it because invocations are
    // counted separately.
    return unmeasured(
      m,
      "the analytics API reported no invocation outcomes at all for the window",
      findings,
    );
  }

  return {
    verdict: findings.length === 0 ? "pass" : "fail",
    exit: findings.length === 0 ? JUDGE_EXIT.pass : JUDGE_EXIT.fail,
    findings,
    measurements: m,
    incomplete: [],
  };
}

/**
 * The platform half could not be read, and the rest of the run still happened.
 *
 * It CARRIES the findings the other bars already produced (#2261). Returning only
 * the platform one discarded them, and the first real run proved how much that
 * costs: a burst with two winners and a fault pass that answered three 500s were
 * both measured, both real, and both silently dropped, so the report said nothing
 * but "the analytics API did not report" while the run held two genuine defects.
 * Cloudflare's pipeline having lagged says nothing whatever about bars that were
 * measured from the run's own files.
 *
 * So the VERDICT depends on what those bars found. A measured failure is a failure
 * whatever the analytics did, and calling that `unmeasured` would file a red run
 * under "could not conclude", which is how a finding stops being read (L11).
 * `unmeasured` is reserved for the case where the platform half is the ONLY thing
 * with anything to say.
 */
function unmeasured(m: RunMeasurements, why: string, findings: Finding[]): JudgeResult {
  const measuredFailures = findings.length > 0;
  return {
    verdict: measuredFailures ? "fail" : "unmeasured",
    exit: measuredFailures ? JUDGE_EXIT.fail : JUDGE_EXIT.unmeasured,
    findings: [...findings, { bar: "platform limits", detail: why }],
    measurements: m,
    incomplete: [],
  };
}
