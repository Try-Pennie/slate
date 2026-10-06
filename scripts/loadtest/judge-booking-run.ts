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
import {
  absoluteBarText,
  judgeLatency,
  LOAD_OVER_REST_RATIO_BAR,
  type BaselineReading,
  type LatencyJudgement,
} from "./latency-bar.ts";
import type { BookingAttempt, DriverResult } from "./book-plan.ts";
import { AVAILABILITY_UNREAD, NO_SLOTS_OFFERED, TIMED_OUT } from "./outcomes.ts";
import { HEALTHY_INVOCATION_STATUS, type ScheduledReading } from "./platform-reading.ts";
import { CEILING_CONCLUSION, type CeilingVerdict } from "./preflight-checks.ts";
// The judge reads the reader's span list at runtime; the reader never imports the
// judge, so the two stay one direction apart.
import { WAIT_SPAN_FIELDS, type ConfirmStartupReading, type LineSplit, type SideWaits } from "./confirm-startup.ts";
import { LOADTEST_LEGS, type WaitSpanField } from "../../src/lib/booking/wait-marks.ts";
import { COLD_SAMPLES_TARGET, coldSampleCounts, isAnsweredSample, type ColdLegResult } from "./cold-plan.ts";
import { CRON_BUDGET_WARN_SHARE } from "../../src/lib/monitor/cron-budget.ts";
import type { SoakSample } from "./invariants.ts";
import {
  faultLaneIncompleteness,
  judgeFaultLanes,
  type FaultLaneEvidence,
  type FaultLaneExpectations,
} from "./fault-lanes.ts";
import { everyTargetDegrades, parseFaultTargets } from "../../src/lib/loadtest-fault.ts";
import { ANSWERED_AT_HEADER, CONFIRM_LINE_HEADER, type LoadtestEcho } from "../../src/lib/loadtest-echo.ts";

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
  faultPass?: {
    attempts: number;
    /**
     * How many of `attempts` were never sent because their bucket's times could not be
     * read (#3348). The fault drivers run the steady loop, so they record these too, and
     * a pass is judged on the requests it SENT: a pass whose attempts were all unsent
     * proved nothing however many it counted. Required, so a construction site that
     * never counted them fails `tsc` rather than reading as none.
     */
    availabilityUnread: number;
    fiveXx: number;
    faultPct: number;
    faultTargets: string[];
    /**
     * The fault drivers' own files and the plan each was meant to run (#3222), so
     * they get exactly the file checks a steady driver gets and a pass cut short at
     * its deadline fails with its figures. Absent on a hand built input.
     */
    drivers?: DriverResult[];
    expectedPerDriver?: number;
  };
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
  expectedLegs: {
    burstDrivers: number;
    /**
     * #3325: how many bursts the run was configured to fire, each with
     * `burstDrivers` drivers. Absent is the shape before #3325, one burst, so a hand
     * built input from then judges exactly as it did.
     */
    bursts?: number;
    faultPct: number;
    faultTargets?: readonly string[];
    /** #3258: whether the run was configured with a same day baseline leg. */
    baseline?: boolean;
  };
  /**
   * #3258: the same day baseline, a dozen bookings at rest on the same deployment
   * just before the steady pass, as the judge entry found it (`baselineReading`).
   * The steady pass's latency is judged against its median (`latency-bar.ts`).
   */
  baseline?: BaselineReading;
  /**
   * Result files the gatherer found and could not use as a steady driver's (#3222):
   * unparsable, or a `driver-N.json` in another mode. Required, so `tsc` names every
   * construction site. A driver with no steady file is named by THIS cause when one
   * matches its file name, because "hung or crashed" claims something a corrupt or
   * mislabelled file never measured (L11).
   */
  unreadableDriverFiles: { file: string; why: string }[];
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
 * How a refused request is named in a finding: its status and its outcome, or "no
 * outcome" when the response carried none. One helper for every burst finding, so a
 * missing outcome can never render as "undefined" in one of them (#3103).
 */
export function refusalLabel(a: BookingAttempt): string {
  const outcome = a.outcome ?? "";
  return `${a.status} ${outcome === "" ? "no outcome" : outcome}`;
}

/** Whether a request was refused because the slot was taken, read the same way. */
export function isSlotTaken(a: BookingAttempt): boolean {
  return a.status === 409 && (a.outcome ?? "") === "SLOT_TAKEN";
}

/**
 * What is wrong with one driver's FILE, steady or fault alike (#3222).
 *
 * A driver that stopped at its own deadline wrote a whole partial file, and that is
 * a run that happened slowly: it is judged, and the share it completed fails a bar
 * of its own. Only a file that disagrees with itself (a count that does not match
 * what it holds, a plan that is not the run's) or one short of its plan with no word
 * of why is unreadable as a run.
 */
export function driverFileProblems(r: DriverResult, expectedPlanned: number, label: string): string[] {
  const why: string[] = [];
  if (r.cutShort) {
    if (r.planned !== expectedPlanned) {
      why.push(`${label} was cut short against a plan of ${r.planned}, not the run's ${expectedPlanned}`);
    }
    if (r.cutShort.attemptsMade !== r.attempts.length || r.attempts.length >= expectedPlanned) {
      why.push(
        `${label} says it was cut short after ${r.cutShort.attemptsMade} requests and its file ` +
          `holds ${r.attempts.length} of ${expectedPlanned}, so the file is not a whole partial run`,
      );
    }
  } else if (r.attempts.length !== expectedPlanned) {
    why.push(`${label} recorded ${r.attempts.length} attempts, expected ${expectedPlanned}`);
  }
  return why;
}

/**
 * How long after the LAST winner of a burst every SLOT_TAKEN must have been
 * answered, on the deployment's own clock (#3325).
 *
 * The shared confirm line exists so that a crowd for one slot is told it is taken
 * at the speed of one confirm rather than queuing behind each other: run 37333201026
 * had about fifty two leaders on fifty two isolates, a twelve second budget, answers
 * at about thirteen seconds and nobody booked. Two seconds is the bound Dan set on
 * 2026-10-05 for "answered SLOT_TAKEN quickly". Measured from the LAST winner rather
 * than the first, because a crowd walking a ladder legitimately produces winners at
 * different moments, one per free advisor, and a loser is told as soon as the last
 * free advisor is gone.
 */
export const BURST_LOSER_LAG_MS = 2_000;

/** Which burst of the run a burst driver file holds; zero for a file from before #3325. */
function legIndexOf(r: DriverResult): number {
  return r.burstLeg?.index ?? 0;
}

/** How many bursts the run was configured to fire (one before #3325, none with no burst leg). */
function configuredLegs(input: JudgeInput): number {
  if (input.expectedLegs.burstDrivers <= 0) return 0;
  return input.expectedLegs.bursts ?? 1;
}

/** One burst of the run, as the judge groups its files (#3325). */
export interface BurstLegGroup {
  index: number;
  /** How many bursts the run holds, for the label. */
  of: number;
  /** The slot it fired at, when any file says. */
  slot: string | null;
  files: DriverResult[];
}

/**
 * The run's bursts, each with its own files, in firing order (#3325).
 *
 * Every burst the run was CONFIGURED to fire is here even when none of its files
 * arrived, so a burst that produced nothing is judged as missing rather than read as
 * a run with fewer bursts (L98). A burst a file names that the configuration did not
 * is here too, and judged, rather than dropped.
 */
export function burstLegGroups(input: JudgeInput): BurstLegGroup[] {
  const byIndex = new Map<number, DriverResult[]>();
  for (let i = 0; i < configuredLegs(input); i++) byIndex.set(i, []);
  for (const r of input.burstResults) {
    const list = byIndex.get(legIndexOf(r)) ?? [];
    list.push(r);
    byIndex.set(legIndexOf(r), list);
  }
  const indices = [...byIndex.keys()].sort((a, b) => a - b);
  const of = Math.max(configuredLegs(input), ...indices.map((i) => i + 1), 0);
  return indices.map((index) => {
    const files = byIndex.get(index)!.slice().sort((a, b) => a.driver - b.driver);
    const first = files[0];
    return { index, of, slot: first?.burstLeg?.slot ?? first?.attempts[0]?.startIso ?? null, files };
  });
}

/** How every finding about one burst names it, so the report says WHICH burst. */
export function burstLegLabel(g: Pick<BurstLegGroup, "index" | "of" | "slot">): string {
  return `burst ${g.index + 1} of ${g.of}${g.slot ? ` (${g.slot})` : ""}`;
}

/**
 * Why one burst did not happen as configured, or nothing (#3222, per burst since #3325).
 *
 * Each reason FAILS the burst rather than making the run incomplete. It used to be
 * incompleteness, and a late burst driver exits non-zero by design, which failed the
 * burst job and skipped the steady pass behind it: one late driver cost the run every
 * figure it had. The contention question ("one winner per agent") is still never
 * asked of a burst that was not whole, because it would be answered by however many
 * drivers happened to arrive (L11). The other bursts are still asked it: one late
 * wake costs the run one burst, not three.
 */
function legShortfall(g: BurstLegGroup, wantDrivers: number): string[] {
  const why: string[] = [];
  for (const b of g.files) {
    if (b.burstSkipped) {
      why.push(`burst driver ${b.driver} did not fire (${b.burstSkipped}), so the burst was not simultaneous`);
    } else if (b.attempts.length !== b.planned) {
      why.push(
        `burst driver ${b.driver} fired ${b.attempts.length} of ${b.planned} planned requests, so ` +
          "the burst was smaller than the one configured",
      );
    }
  }
  // A burst the run was configured to have and did not get whole. Answering the
  // winners question over nothing is how a missing control reads as a passing one.
  if (wantDrivers > 0 && g.files.length !== wantDrivers) {
    why.push(
      `${g.files.length} burst driver files, expected ${wantDrivers}. A burst judged on ` +
        "fewer drivers than fired is not the contention the control counts.",
    );
  }
  return why;
}

/** Every burst's shortfall, each naming its burst (#3222, #3325). */
export function burstShortfall(input: JudgeInput): string[] {
  const want = input.expectedLegs.burstDrivers;
  return burstLegGroups(input).flatMap((g) => legShortfall(g, want).map((w) => `${burstLegLabel(g)}: ${w}`));
}

/**
 * How one answer names the confirm line that served it, the one way findings and the
 * report spell it (#3325): `shared/ok`, `fallback/reach-timeout`, or what the
 * deployment failed to say. A value the contract does not know is QUOTED, never
 * dropped and never read as one it does.
 */
export function lineReasonLabel(echo: LoadtestEcho | null | undefined): string {
  // `undefined` too: a driver file written before #3325 carries no echo field, and it
  // is a deployment that said nothing, never a crash that leaves the run unjudged.
  if (!echo || echo.line.state === "absent") return "no line header";
  if (echo.line.state === "unreadable") return `unreadable line ${JSON.stringify(echo.line.raw)}`;
  const r = echo.reason;
  const reason = r.state === "read" ? r.value : r.state === "absent" ? "no reason" : `unreadable reason ${JSON.stringify(r.raw)}`;
  return `${echo.line.value}/${reason}`;
}

/** The answers' lines, counted by line and reason. */
function tallyLines(attempts: readonly BookingAttempt[]): {
  byLineReason: Record<string, number>;
  shared: number;
  notSaid: number;
  unreadable: number;
} {
  const byLineReason: Record<string, number> = {};
  let shared = 0;
  let notSaid = 0;
  let unreadable = 0;
  for (const a of attempts) {
    const label = lineReasonLabel(a.echo);
    byLineReason[label] = (byLineReason[label] ?? 0) + 1;
    const line = a.echo?.line;
    if (!line || line.state === "absent") notSaid += 1;
    else if (line.state === "unreadable") unreadable += 1;
    else if (line.value === "shared") shared += 1;
  }
  return { byLineReason, shared, notSaid, unreadable };
}

/** A tally as `label count` pairs, the commonest first, for a finding or a report line. */
function tallyText(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, n]) => `${label} ${n}`)
    .join(", ");
}

/** What the burst's speed clause found, or why it could not (#3325). */
export type BurstSpeedReading =
  | {
      kind: "measured";
      /** The last winner's answer, on the deployment's clock. */
      lastOkAtMs: number;
      /** The slowest SLOT_TAKEN, in ms after the last winner (negative when before it). */
      worstLagMs: number;
      /** SLOT_TAKEN answers past `BURST_LOSER_LAG_MS`. */
      late: number;
      slotTaken: number;
    }
  | { kind: "unmeasured"; why: string };

/**
 * How soon after the LAST winner each SLOT_TAKEN was answered, on the deployment's
 * own answer stamps (#3325).
 *
 * Every way of learning nothing is UNMEASURED, and unmeasured fails: an answer with
 * no readable stamp, a burst nobody won (no winner to measure against), and a burst
 * nobody lost (no loser to measure). A stamp that never arrived is never read as a
 * fast answer, and finding nothing to measure is never a pass (L98).
 */
export function burstSpeed(attempts: readonly BookingAttempt[]): BurstSpeedReading {
  // A request with no reply is not an answer missing its stamp, so it is counted on
  // its own: either way the slowest loser is unknown, but only one of them is a
  // header fault (#3337 review, L11).
  const answered = attempts.filter((a) => a.status !== 0);
  const noReply = attempts.length - answered.length;
  let absent = 0;
  let unreadable = 0;
  const at = new Map<BookingAttempt, number>();
  for (const a of answered) {
    const stamp = a.echo?.answeredAtMs;
    if (!stamp || stamp.state === "absent") absent += 1;
    else if (stamp.state === "unreadable") unreadable += 1;
    else at.set(a, stamp.value);
  }
  if (noReply + absent + unreadable > 0) {
    const why: string[] = [];
    if (noReply > 0) {
      why.push(`${noReply} of ${attempts.length} burst requests got no reply, so when they would have been answered is unknown`);
    }
    if (absent + unreadable > 0) {
      why.push(
        `${absent + unreadable} of ${answered.length} burst answers carried no readable ` +
          `${ANSWERED_AT_HEADER} stamp (${absent} absent, ${unreadable} unreadable)`,
      );
    }
    return { kind: "unmeasured", why: why.join("; ") };
  }
  const won = attempts.filter((a) => a.status === 200);
  if (won.length === 0) {
    return {
      kind: "unmeasured",
      why: "no request was answered 200, so there is no winner to measure the SLOT_TAKEN answers against",
    };
  }
  const taken = attempts.filter(isSlotTaken);
  if (taken.length === 0) {
    return {
      kind: "unmeasured",
      why: "no request was refused SLOT_TAKEN, so how fast the losers are told was never tested",
    };
  }
  const lastOkAtMs = Math.max(...won.map((a) => at.get(a)!));
  const lags = taken.map((a) => at.get(a)! - lastOkAtMs);
  return {
    kind: "measured",
    lastOkAtMs,
    worstLagMs: Math.max(...lags),
    late: lags.filter((l) => l > BURST_LOSER_LAG_MS).length,
    slotTaken: taken.length,
  };
}

/** What one burst measured, for the report and for the judge's own findings (#3325). */
export interface BurstLegReading {
  index: number;
  of: number;
  label: string;
  /** Requests the burst's files hold, and how many of them got an answer. */
  attempts: number;
  answered: number;
  won: number;
  slotTaken: number;
  /** Requests per code, so the split across the two siblings is visible. */
  codes: Record<string, number>;
  /** The answered requests' lines, by line and reason. */
  lines: Record<string, number>;
  /** Answered requests that took the shared line under a LADDER key. */
  ladderKeys: number;
  speed: BurstSpeedReading;
  /** The bars this burst failed, filled in by the judge; empty for a burst that passed. */
  failed: string[];
}

/** One reading per burst, from the same grouping the judge uses (L41). */
export function burstLegReadings(input: JudgeInput): BurstLegReading[] {
  return burstLegGroups(input).map((g) => {
    const attempts = attemptsOf(g.files);
    const answered = attempts.filter((a) => a.status !== 0);
    const codes: Record<string, number> = {};
    for (const a of attempts) codes[a.code] = (codes[a.code] ?? 0) + 1;
    return {
      index: g.index,
      of: g.of,
      label: burstLegLabel(g),
      attempts: attempts.length,
      answered: answered.length,
      won: attempts.filter((a) => a.status === 200).length,
      slotTaken: attempts.filter(isSlotTaken).length,
      codes,
      lines: tallyLines(answered).byLineReason,
      ladderKeys: answered.filter((a) => a.echo?.key.state === "read" && a.echo.key.value === "ladder").length,
      speed: burstSpeed(attempts),
      failed: [],
    };
  });
}

/** Which confirm line the steady pass's answers took, and the time it added (#3325). */
export interface SteadyLineReading {
  /** Steady requests that got an answer. */
  answered: number;
  byLineReason: Record<string, number>;
  /** Answers that carried no line header. */
  notSaid: number;
  /** Answers whose line header the contract does not know. */
  unreadable: number;
  /**
   * The absolute time the line added per confirm, from `x-loadtest-confirm-line-ms`.
   * Reported beside the ratio bar because the ratio alone hides an overhead the
   * at rest baseline pays too. Null when no answer carried a readable time, never 0.
   */
  lineMs: ReturnType<typeof percentiles>;
  /** Answers with no readable time, counted rather than scored zero (L90). */
  lineMsUnread: number;
}

/** The steady pass's line reading. A report, never a bar (#3325). */
export function steadyLineReading(attempts: readonly BookingAttempt[]): SteadyLineReading {
  const answered = attempts.filter((a) => a.status !== 0);
  const t = tallyLines(answered);
  const ms: number[] = [];
  for (const a of answered) {
    const v = a.echo?.lineMs;
    if (v?.state === "read") ms.push(v.value);
  }
  return {
    answered: answered.length,
    byLineReason: t.byLineReason,
    notSaid: t.notSaid,
    unreadable: t.unreadable,
    lineMs: percentiles(ms),
    lineMsUnread: answered.length - ms.length,
  };
}

/** The span names as a report reads them, in the order a confirm passes them. */
export const WAIT_SPAN_LABELS: Record<WaitSpanField, string> = {
  wait_route_ms: "route",
  wait_auth_ms: "auth",
  wait_pre_line_ms: "before the line",
  wait_line_ms: "line",
  wait_decide_ms: "person decision",
  wait_to_profile_ms: "to the profile",
  wait_total_ms: "whole",
};

/**
 * #3354: the wait before the confirm's profile, by span, as one report line. A
 * report line, never a bar: it says where the wait the confirm startup bar judges
 * went, so a fix can be aimed at the span that moved. Each span's median and p95
 * come through the judge's own `percentiles` (L41), cold and warm apart, with how
 * many confirms carried marks, because a span read from a few of them is not the
 * whole population (L712).
 */
export function waitSpanText(cs: ConfirmStartupReading | null): string {
  const head = "- the wait before the profile, by span";
  if (cs === null) return `${head}: the archived log was not read, so the wait was not split`;
  if (cs.markedSamples === 0) {
    return (
      `${head}: no confirm carried marks, so the wait was not split (the marks are written under ` +
      "SLATE_LOADTEST by a deployment that has #3354)"
    );
  }
  const side = (label: "cold" | "warm", n: number, spans: Record<string, number[]>) => {
    // The confirms that carried marks or an invocation index, counted by the reader,
    // never the longest span list, which misses a confirm that carried only an index.
    const marked = cs.markedBySide[label];
    const parts = WAIT_SPAN_FIELDS.flatMap((f) => {
      const p = percentiles(spans[f] ?? []);
      return p === null ? [] : [`${WAIT_SPAN_LABELS[f]} p50 ${p.p50}ms p95 ${p.p95}ms`];
    });
    return `${label} n=${n}, ${marked} marked${parts.length > 0 ? `: ${parts.join(", ")}` : ""}`;
  };
  return (
    `${head}: ${side("cold", cs.cold, cs.waitSpans.cold)}; ` +
    `${side("warm", cs.samples - cs.cold, cs.waitSpans.warm)}; ` +
    `${cs.firstRequests} of ${cs.invocationIndexKnown} confirms with an invocation index were their isolate's first request`
  );
}

/**
 * #3354: the shared line's wait, split by the object's own log of the calls each
 * confirm sent while it waited (`confirm-startup.ts`, `LineSplit`), as one report line.
 * A report line, never a bar: it says whether a line wait is time behind a leader,
 * the object's own work, or everything outside the object, so a fix is aimed at the
 * part that moved. Every count that is not a reading is named, never folded in (L98).
 */
export function lineSplitText(cs: ConfirmStartupReading | null): string {
  const head = "- the shared line's wait, by where it went";
  if (cs === null) return `${head}: the archived log was not read, so the line's wait was not split`;
  const { cold, warm, orphanCalls } = cs.lineSplit;
  if (cold.traced + warm.traced === 0) {
    return (
      `${head}: no confirm on the shared line carried a trace, so the line's wait was not split ` +
      "(traces are sent under SLATE_LOADTEST by a deployment that has #3354's line object log)"
    );
  }
  const p = (xs: number[]) => {
    const q = percentiles(xs);
    return q === null ? "n/a" : `p50 ${q.p50}ms p95 ${q.p95}ms`;
  };
  const side = (label: string, x: LineSplit) => {
    const lost = [
      x.missing > 0 ? `${x.missing} missing` : null,
      x.impossible > 0 ? `${x.impossible} impossible` : null,
      x.unreadable > 0 ? `${x.unreadable} unreadable` : null,
    ].filter((t): t is string => t !== null);
    const reading =
      x.joined === 0
        ? "nothing to split"
        : `behind a leader ${p(x.heldMs)}, in the object ${p(x.objectMs)}, outside the object ${p(x.outsideMs)}`;
    return `${label} ${x.joined} of ${x.traced} traced${lost.length > 0 ? ` (${lost.join(", ")})` : ""}: ${reading}`;
  };
  return (
    `${head}: ${side("cold", cold)}; ${side("warm", warm)}` +
    (orphanCalls > 0 ? `; ${orphanCalls} object calls matched no confirm in the archive` : "")
  );
}

/**
 * #3354: the wait before the profile, by the Worker version that served each confirm
 * and by the load run leg that sent it, as one report line. A run's cold confirms come
 * from different places (a fresh deploy's first requests, the burst's crowd, the fault
 * leg's redeploy), and the startup bar's one figure cannot say which. The slowest cold
 * confirm is given because, at the handful of cold confirms a run has, it IS the p95.
 */
export function startupOriginText(cs: ConfirmStartupReading | null): string {
  const head = "- the wait before the profile, by origin";
  if (cs === null) return `${head}: the archived log was not read, so the confirms were not split`;
  const group = (name: string, w: SideWaits) => {
    const warm = percentiles(w.warm);
    return (
      `${name} cold n=${w.cold.length}${w.cold.length > 0 ? ` max ${Math.max(...w.cold)}ms` : ""}, ` +
      `warm n=${w.warm.length}${warm === null ? "" : ` p95 ${warm.p95}ms`}`
    );
  };
  const versions = Object.entries(cs.byVersion)
    .sort(([, a], [, b]) => b.cold.length + b.warm.length - (a.cold.length + a.warm.length))
    .map(([v, w]) => group(v.slice(0, 8), w));
  const order = [...LOADTEST_LEGS, "unreadable", "none"] as string[];
  const legs = Object.entries(cs.byLeg)
    .sort(([a], [b]) => (order.indexOf(a) === -1 ? order.length : order.indexOf(a)) - (order.indexOf(b) === -1 ? order.length : order.indexOf(b)))
    .map(([l, w]) => group(l, w));
  return `${head}: by script version ${versions.join("; ") || "none read"}; by leg ${legs.join("; ") || "none read"}`;
}

/**
 * #3354: the diagnostic cold leg as one report line. A load run's own cold confirms
 * number about ten, so its cold p95 is its slowest; this leg deploys a version and
 * sends one confirm, N times, for a distribution a startup change can be judged
 * against. Never a bar. Every way it can come back short is said in its own words: not
 * asked for, its results never arriving, its log not read, a deploy that made no
 * version, a confirm that landed on an older version, and fewer cold samples than the
 * plan asked for (L98).
 */
export function coldAfterDeployText(input: {
  expected: number;
  result: ColdLegResult | null;
  /** Why the run's cold_samples could not be read, when it could not; the job still started. */
  expectedUnreadable?: string | null;
  /** Why the results file was there and could not be used, or absent/null when it was not. */
  unreadable?: string | null;
  reading: ConfirmStartupReading | null;
}): string {
  const head = "- cold after deploy (diagnostic, not a bar)";
  if (input.result === null && input.expectedUnreadable) {
    return `${head}: ${input.expectedUnreadable}, so the cold job refused it before installing anything and nothing was measured`;
  }
  if (input.result === null && input.unreadable) {
    return `${head}: its results file could not be read (${input.unreadable}), so nothing was measured`;
  }
  // Results that arrived are reported whatever the run said it asked for, so a setting
  // the judge could not read never hides a leg that ran.
  if (input.expected === 0 && input.result === null) return `${head}: not asked for (cold_samples was 0)`;
  if (input.result === null) {
    return `${head}: asked for ${input.expected} samples and the leg's results never arrived, so nothing was measured`;
  }
  if (input.result.refused !== undefined) {
    return `${head}: asked for ${input.result.planned}; the leg refused before any deploy (${input.result.refused}), so nothing was measured`;
  }
  // Counted the way the leg's own exit line counts them, from one helper (L41).
  const c = coldSampleCounts(input.result);
  const asked =
    `asked for ${c.planned}; ${c.deployed} of ${c.planned} deploys made a version` +
    `${c.deployFailed > 0 ? ` (${c.deployFailed} failed)` : ""} and ${c.answered} confirms answered` +
    `${c.created < c.answered ? ` (${c.answered - c.created} refused rather than booked)` : ""}` +
    `${c.noAnswer > 0 ? ` (${c.noAnswer} got no answer)` : ""}`;
  const r = input.reading;
  if (r === null) return `${head}: ${asked}; its log was not archived or not read, so their startup was not measured`;
  // The reading is the cold leg's own (run-judge reads the tail with `leg: "cold"`), so
  // the versions, the first requests and the spans below describe the same confirms as
  // the waits. `byLeg.cold` is still read, so a reading of a whole archive handed in
  // here cannot pass another leg's waits off as this leg's.
  const versions = new Set(Object.keys(r.byVersion));
  const onOwn = input.result.attempts.filter((a) => isAnsweredSample(a) && a.version !== null && versions.has(a.version)).length;
  const own = r.byLeg.cold ?? { cold: [], warm: [] };
  const otherLegs = r.otherLegs ?? 0;
  const leftOut = otherLegs > 0 ? ` (${otherLegs} confirm${otherLegs === 1 ? "" : "s"} from another leg left out)` : "";
  const p = percentiles(own.cold);
  const spans = WAIT_SPAN_FIELDS.flatMap((f) => {
    const q = percentiles(r.waitSpans.cold[f] ?? []);
    return q === null ? [] : [`${WAIT_SPAN_LABELS[f]} p50 ${q.p50}ms`];
  });
  return (
    `${head}: ${asked}; the log read ${own.cold.length + own.warm.length} of them${leftOut}, ${onOwn} on the version just deployed, ` +
    `${own.cold.length} the first on their isolate (${r.firstRequests} the Worker's first request)` +
    (p === null ? "; no cold confirm, so nothing to report on the wait" : `; before the profile p50 ${p.p50}ms p95 ${p.p95}ms max ${p.max}ms`) +
    (own.cold.length < COLD_SAMPLES_TARGET ? `, short of the ${COLD_SAMPLES_TARGET} a startup change is judged against` : "") +
    (spans.length > 0 ? `; by span ${spans.join(", ")}` : "")
  );
}

/** The steady line reading as one report line, so the report never re-derives it (L41). */
export function steadyLineText(r: SteadyLineReading): string {
  if (r.answered === 0) return "the confirm line on the steady pass: no request was answered, so nothing was read";
  const shared = r.byLineReason["shared/ok"] ?? 0;
  return (
    `the confirm line on the steady pass (reported, not a bar): ${tallyText(r.byLineReason)} over ` +
    `${r.answered} answered requests (${((shared / r.answered) * 100).toFixed(1)}% shared/ok); the ` +
    "absolute time the line added per confirm: " +
    (r.lineMs === null
      ? "not measured, no answer carried a readable time"
      : `p50 ${r.lineMs.p50}ms, p95 ${r.lineMs.p95}ms, max ${r.lineMs.max}ms`) +
    (r.lineMsUnread > 0 ? ` (${r.lineMsUnread} answers carried no readable time)` : "")
  );
}

/**
 * The bursts in one line, naming every one that failed (#3325), or null for a run
 * with no burst leg. Any one burst failing fails the run, so the reader is told which
 * before reading the per burst lines.
 */
export function burstsSummaryText(readings: readonly BurstLegReading[]): string | null {
  if (readings.length === 0) return null;
  const failed = readings.filter((r) => r.failed.length > 0);
  if (failed.length === 0) return `the bursts: ${readings.length} judged, and every one passed`;
  return (
    `the bursts: ${failed.length} of ${readings.length} FAILED, which fails the run: ` +
    failed.map((r) => `${r.label} (${r.failed.join(", ")})`).join("; ")
  );
}

/** One burst's reading as one report line (#3325). */
export function burstLegText(r: BurstLegReading): string {
  const verdict = r.failed.length === 0 ? "passed" : `FAILED (${r.failed.join(", ")})`;
  const speed =
    r.speed.kind === "unmeasured"
      ? `losers' speed not measured: ${r.speed.why}`
      : `the slowest of ${r.speed.slotTaken} SLOT_TAKEN came ${r.speed.worstLagMs}ms after the last 200 ` +
        `(bound ${BURST_LOSER_LAG_MS}ms, ${r.speed.late} past it)`;
  const ladder = r.answered === 0 ? "n/a" : `${r.ladderKeys} of ${r.answered} (${((r.ladderKeys / r.answered) * 100).toFixed(1)}%)`;
  return (
    `${r.label}: ${verdict}; ${r.attempts} requests (${tallyText(r.codes) || "none"}), ${r.won} won, ` +
    `${r.slotTaken} SLOT_TAKEN; line: ${tallyText(r.lines) || "nothing answered"}; ladder key on ${ladder}; ${speed}`
  );
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
    // WHICH one, and what its silence means (#3222). A slow driver stops at its own
    // deadline and writes what it ran, so a driver with no file at all hung or
    // crashed, and that is a different place to look from a slow deployment.
    const present = new Set(input.driverResults.map((r) => r.driver));
    for (let d = 0; d < input.target.drivers; d++) {
      if (present.has(d)) continue;
      const bad = input.unreadableDriverFiles.find((f) => f.file === `driver-${d}.json`);
      why.push(
        bad
          ? `driver ${d}'s file ${bad.file} could not be read as its steady result: ${bad.why}`
          : `driver ${d} wrote no result file: it hung or crashed before writing one, or its ` +
              "artifact never arrived. A slow driver stops at its own deadline and writes what it ran",
      );
    }
  }
  const seen = new Set(input.driverResults.map((r) => r.driver));
  if (seen.size !== input.driverResults.length) {
    why.push("two driver files claim the same driver number, so one driver's run is missing");
  }
  for (const r of input.driverResults) {
    if (r.runId !== input.runId) {
      why.push(`driver ${r.driver}'s file is from run ${r.runId}, not ${input.runId}`);
    }
    why.push(...driverFileProblems(r, expectedPerDriver, `driver ${r.driver}`));
  }
  if (input.freshnessSamples.length !== input.target.minutes) {
    why.push(
      `${input.freshnessSamples.length} freshness samples, expected one a minute for ` +
        `${input.target.minutes} minutes. A short sample never reaches the age a full window does.`,
    );
  }
  // A burst that did not happen as configured (a driver that missed its moment, a
  // file that never arrived, a driver that fired part of its plan) is NOT here: it
  // FAILS the burst bar with its reason (`burstShortfall`, #3222), so a late burst
  // driver no longer costs the run its steady figures.
  // Per burst (#3325): one driver fires every burst, so the same driver number across
  // bursts is the plan, and twice within ONE burst is a file standing in for another.
  const seenBurst = new Set<string>();
  for (const b of input.burstResults) {
    const key = `${legIndexOf(b)}:${b.driver}`;
    if (seenBurst.has(key)) {
      why.push(
        `two burst driver files claim driver ${b.driver} in burst ${legIndexOf(b) + 1}, so one driver's ` +
          "burst is missing",
      );
    }
    seenBurst.add(key);
  }
  for (const b of input.burstResults) {
    if (b.runId !== input.runId) {
      why.push(`burst driver ${b.driver}'s file is from run ${b.runId}, not ${input.runId}`);
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
  // The fault drivers' files get the steady drivers' checks (#3222).
  if (input.faultPass?.drivers && input.faultPass.expectedPerDriver !== undefined) {
    for (const r of input.faultPass.drivers) {
      why.push(...driverFileProblems(r, input.faultPass.expectedPerDriver, `fault driver ${r.driver}`));
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
  /** #3258: which latency rule judged the run and what it measured, set once judged. */
  latency?: LatencyJudgement;
  /** What the plan held across every steady driver, so `attempts` reads against it. */
  planned: number;
  attempts: number;
  /**
   * The drivers that stopped at their own deadline before the plan was done (#3222),
   * empty on a run that finished.
   */
  cutShort: { driver: number; made: number; planned: number; deadlineMs: number }[];
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
  /**
   * Requests the driver gave up on at its own abort bound (#3222), kept apart from
   * `noReply`: a deployment that answered nothing in thirty seconds and a transport
   * that failed are two different findings (L11).
   */
  timedOut: number;
  /**
   * #3348: requests never sent because their bucket's times could not be read at all.
   * Kept apart from `noReply` (nothing was sent to go unanswered) and from a bucket
   * offering nothing (the bucket never answered).
   */
  availabilityUnread: number;
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
  /** #3325: one reading per burst, each judged on its own; `failed` names its bars. */
  bursts: BurstLegReading[];
  /** #3325: which confirm line the steady pass took, and the time it added. A report. */
  steadyLine: SteadyLineReading;
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
    planned: input.target.drivers * input.target.perDriverPerMinute * input.target.minutes,
    attempts: attempts.length,
    cutShort: input.driverResults
      .filter((r) => r.cutShort)
      .map((r) => ({
        driver: r.driver,
        made: r.attempts.length,
        planned: r.planned,
        deadlineMs: r.cutShort!.deadlineMs,
      })),
    confirmed,
    confirmedPerMinute: input.target.minutes === 0 ? 0 : confirmed / input.target.minutes,
    targetPerMinute: input.target.drivers * input.target.perDriverPerMinute,
    outcomes,
    all: percentiles(attempts.map((a) => a.wallMs)),
    ok: percentiles(attempts.filter((a) => a.status === 200).map((a) => a.wallMs)),
    fiveXx: attempts.filter((a) => a.status >= 500).length,
    noReply: attempts.filter(
      (a) => a.status === 0 && a.outcome !== NO_SLOTS_OFFERED && a.outcome !== TIMED_OUT && a.outcome !== AVAILABILITY_UNREAD,
    ).length,
    availabilityUnread: attempts.filter((a) => a.outcome === AVAILABILITY_UNREAD).length,
    timedOut: attempts.filter((a) => a.status === 0 && a.outcome === TIMED_OUT).length,
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
    bursts: burstLegReadings(input),
    steadyLine: steadyLineReading(attempts),
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
 *
 * Production warns at the same line every day (#3141), so this is that constant rather
 * than a second 0.5 that could be moved alone.
 */
export const CRON_CPU_MARGIN_SHARE = CRON_BUDGET_WARN_SHARE;

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
  /**
   * #3258: why the speed verdict is void, or null when it was judged. Set when the
   * run's same day baseline could not be used; the verdict above is then every
   * OTHER bar's, and a reader must be told the speed was not measured (Dan,
   * 2026-10-05).
   */
  speedUnmeasured: string | null;
  /** #3294 review: why the platform reading was unmeasured, or null when it was read. */
  platformUnmeasured: string | null;
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

/**
 * The fault pass's counts, from the fault drivers' own attempts (#3348). Here rather
 * than in run-judge so the count the judge is handed is the one the tests pin: an
 * unsent attempt is counted by its outcome, a 5xx by its status.
 */
export function faultPassCounts(attempts: readonly BookingAttempt[]): { attempts: number; availabilityUnread: number; fiveXx: number } {
  return {
    attempts: attempts.length,
    availabilityUnread: attempts.filter((a) => a.outcome === AVAILABILITY_UNREAD).length,
    fiveXx: attempts.filter((a) => a.status >= 500 && a.status <= 599).length,
  };
}

/**
 * The report's fault pass line (#3104), said on every faulted run, including the ones
 * whose 5xx are reported rather than barred, so a database fault pass's errors are still
 * in front of the reader with the reason they did not fail the run beside them. It counts
 * requests SENT, and names the unsent ones when there are any (#3348).
 */
export function faultPassReportLine(fp: Pick<NonNullable<JudgeInput["faultPass"]>, "attempts" | "availabilityUnread" | "fiveXx" | "faultPct" | "faultTargets">): string {
  return (
    `- fault pass: ${fp.faultTargets.join(", ") || "unrecorded systems"} failing ` +
    `${fp.faultPct} percent of calls; ${fp.attempts - fp.availabilityUnread} requests sent, ` +
    (fp.availabilityUnread > 0 ? `${fp.availabilityUnread} never sent because their bucket's times could not be read, ` : "") +
    `${fp.fiveXx} 5xx ` +
    (faultPassKeepsFiveXxBar(fp.faultTargets)
      ? "(held to no 5xx)"
      : "(reported, not barred: a failure of one of these systems is a 5xx by design)")
  );
}

/** Why the speed verdict is void, read off the latency judgement, or null (#3258). */
function speedUnmeasuredOf(m: RunMeasurements): string | null {
  return m.latency?.kind === "unmeasured" ? m.latency.why : null;
}

/**
 * The questions asked of ONE whole burst (#2261, #2273, #3325): its winners, its
 * losers, which confirm line served it, and how fast its losers were told.
 */
function judgeBurstLeg(
  burst: BookingAttempt[],
  bookings: readonly JudgedBooking[],
  failLeg: (bar: string, detail: string) => void,
  reading: BurstLegReading | undefined,
): void {
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
  const agentOf = new Map(bookings.map((b) => [b.external_id ?? "", b.assigned_user_id]));
  const winningAgents = won.map((a) => agentOf.get(a.externalId) ?? null);
  const namedAgents = winningAgents.filter((id): id is string => id !== null);
  const distinct = new Set(namedAgents);
  if (won.length === 0) {
    // Say what the refusals WERE, by code and count, and claim the slot was already
    // taken only when every one of them says so. Run 37333201026 had an untouched
    // slot and every request refused 503 VERIFY_UNAVAILABLE, and this sentence still
    // told the reader the slot had been taken before the burst fired (L11).
    const counts = new Map<string, number>();
    for (const a of burst) {
      const label = refusalLabel(a);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const refusals = [...counts.entries()]
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .map(([label, n]) => `${n} ${label}`)
      .join(", ");
    const allTaken = burst.every(isSlotTaken);
    failLeg(
      "the burst",
      `none of the ${burst.length} burst requests was answered 200 (${refusals}), ` +
        (allTaken
          ? "so the slot was already taken before the burst fired and nothing about contention was measured"
          : "so nothing about contention was measured"),
    );
  } else if (distinct.size < namedAgents.length) {
    failLeg(
      "the burst's winners",
      `${won.length} of ${burst.length} burst requests were answered 200 and they resolve to ` +
        `only ${distinct.size} agent(s), so an agent holds two active bookings at one slot`,
    );
  } else if (namedAgents.length < won.length) {
    failLeg(
      "the burst's winners",
      `${won.length - namedAgents.length} of the ${won.length} burst requests answered 200 have ` +
        "no booking row naming an agent, so the SLOT_TAKEN answers point at nothing",
    );
  }
  // `a.outcome !== "SLOT_TAKEN"` rather than `!isSlotTaken(a)`, deliberately: a
  // SLOT_TAKEN answered with some other status is reported by neither bar today, and
  // widening this one is a separate decision from how its refusals are labelled.
  // Every non-winner is required to be SLOT_TAKEN here, and whether each winner has a
  // booking row is what the agent lookup above measures.
  const otherRefusals = burst.filter((a) => a.status !== 200 && (a.outcome ?? "") !== "SLOT_TAKEN");
  if (otherRefusals.length > 0) {
    failLeg(
      "the burst's losers",
      `${otherRefusals.length} burst requests were refused for a reason other than the slot being ` +
        `taken (${[...new Set(otherRefusals.map(refusalLabel))].join(", ")})`,
    );
  }

  // --- a. every burst confirm took the SHARED line (#3325) ----------------------
  // The deployment says which line served each confirm, on a load test only header;
  // a SLOT_TAKEN reads the same whichever line produced it, so nothing else can tell.
  // A deployment that says nothing FAILS by name: it is the state of every run until
  // the shared line ships, and a bar with nothing to object to is not a pass (L98).
  const answered = burst.filter((a) => a.status !== 0);
  const lines = tallyLines(answered);
  if (answered.length === 0) {
    failLeg(
      "the burst's line",
      `none of the ${burst.length} burst requests was answered, so which line served the burst is unknown`,
    );
  } else if (lines.notSaid === answered.length) {
    failLeg(
      "the burst's line",
      `the deployment did not say which line served the burst: none of the ${answered.length} answers ` +
        `carried ${CONFIRM_LINE_HEADER}, so whether the shared line ran is unknown`,
    );
  } else if (lines.shared !== answered.length) {
    failLeg(
      "the burst's line",
      `${lines.shared} of ${answered.length} burst confirms took the shared line, and every one must. ` +
        `By line and reason: ${tallyText(lines.byLineReason)}`,
    );
  }

  // --- b. every SLOT_TAKEN within the bound of the LAST winner (#3325) ----------
  // On the deployment's own answer stamps, never four runners' clocks.
  const speed = reading?.speed ?? burstSpeed(burst);
  if (speed.kind === "unmeasured") {
    failLeg(
      "the burst's speed",
      `how fast the losers were answered could not be measured: ${speed.why}. Finding nothing to ` +
        "measure is never a pass",
    );
  } else if (speed.late > 0) {
    failLeg(
      "the burst's speed",
      `${speed.late} of ${speed.slotTaken} SLOT_TAKEN answers came more than ${BURST_LOSER_LAG_MS}ms ` +
        `after the last 200, the slowest ${speed.worstLagMs}ms after it, read on the deployment's own ` +
        "answer stamps",
    );
  }
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
      speedUnmeasured: null,
      platformUnmeasured: null,
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

  // --- the plan ran to the end (#3222) ------------------------------------------
  // A driver sends one request at a time, so a slow deployment stretches the run
  // until a driver meets its own deadline. That is a FAILED run, with the figures
  // that show how far it got, never an unjudged one: the latency bar below is
  // still scored on what ran.
  if (m.cutShort.length > 0) {
    const who = m.cutShort
      .map(
        (c) =>
          `driver ${c.driver} stopped at its ${(c.deadlineMs / 60_000).toFixed(1)} minute deadline ` +
          `after ${c.made} of ${c.planned}`,
      )
      .join("; ");
    const share = m.planned === 0 ? 0 : (m.attempts / m.planned) * 100;
    fail(
      "planned bookings completed",
      `${who}. The run made ${m.attempts} of ${m.planned} planned requests (${share.toFixed(1)}%). ` +
        "The drivers send one request at a time, so slow answers are what push a driver past " +
        "its deadline",
    );
  }

  // --- latency ----------------------------------------------------------------
  // #3258: against a multiple of the same day baseline when the run has one, with
  // the absolute bar still reported; against the absolute bar alone when it has none.
  if (m.ok === null) {
    fail("latency of successful bookings", "not one request succeeded, so there is no p95 to judge");
  } else {
    const latency = judgeLatency({
      steadyP95: m.ok.p95,
      absoluteBarMs: OK_P95_MS,
      baseline: input.baseline,
      baselineExpected: input.expectedLegs.baseline === true,
      runId: input.runId,
    });
    m.latency = latency;
    // Dan, 2026-10-05: an unusable baseline voids the speed verdict ONLY. No latency
    // finding is invented and none is dropped in silence: the result carries why
    // (`speedUnmeasuredOf`).
    if (latency.kind === "relative" && !latency.pass) {
      fail(
        "latency of successful bookings",
        `p95 ${m.ok.p95}ms is ${latency.ratio.toFixed(1)} times the same day baseline's median of ` +
          `${latency.baselineP50}ms (${latency.baselineOk} bookings at rest), over the ` +
          `${LOAD_OVER_REST_RATIO_BAR} times bar of ${latency.barMs}ms (p50 ${m.ok.p50}ms, max ` +
          `${m.ok.max}ms). ${absoluteBarText(latency)}`,
      );
    } else if (latency.kind === "absolute" && !latency.pass) {
      fail(
        "latency of successful bookings",
        `p95 ${m.ok.p95}ms over the ${OK_P95_MS}ms bar (p50 ${m.ok.p50}ms, max ${m.ok.max}ms); ` +
          `${latency.why}`,
      );
    }
  }
  // 5xx and no-reply are reported separately and BOTH fail. A request the
  // deployment answered badly and one it never answered send two different people
  // to two different places (L11).
  if (m.fiveXx > 0) fail("server errors", `${m.fiveXx} responses were 5xx`);
  if (m.noReply > 0) fail("unanswered requests", `${m.noReply} requests got no reply at all`);
  if (m.availabilityUnread > 0) {
    fail(
      "requests never sent",
      `${m.availabilityUnread} request${m.availabilityUnread === 1 ? " was" : "s were"} never sent because the bucket's times ` +
        "could not be read (its first availability read was refused, timed out or failed), so the run did not drive the load it planned",
    );
  }
  if (m.timedOut > 0) {
    fail(
      "timed out requests",
      `${m.timedOut} request${m.timedOut === 1 ? "" : "s"} got no answer inside the driver's own ` +
        "per request bound and were given up on",
    );
  }

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

  // --- the bursts, each judged on its own (#3325) --------------------------------
  // Three bursts, at three slots and three moments, so one lucky spread of isolates
  // cannot pass the run (L395). Any one failing fails the run, and every finding
  // names its burst.
  const wantBurstDrivers = input.expectedLegs.burstDrivers;
  for (const g of burstLegGroups(input)) {
    const label = burstLegLabel(g);
    const reading = m.bursts.find((r) => r.index === g.index);
    const failLeg = (bar: string, detail: string) => {
      fail(bar, `${label}: ${detail}`);
      if (reading && !reading.failed.includes(bar)) reading.failed.push(bar);
    };
    const short = legShortfall(g, wantBurstDrivers);
    for (const w of short) failLeg("the burst", w);
    if (short.length > 0 || g.files.length === 0) continue;
    judgeBurstLeg(attemptsOf(g.files), input.bookings, failLeg, reading);
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
        `own share is taken out: ${cs.cold} of ${cs.samples} confirms here were the first on ` +
        `their isolate, against ${m.confirmWarmStartup === null ? "no" : `p95 ${m.confirmWarmStartup.p95}ms`} ` +
        "on a warm one. The report's span line says where that wait went (#3354: route, auth, " +
        "the confirm line, the person decision); nothing here assumes which. The confirm itself " +
        "is judged separately",
    );
  }
  // #3354: a confirm the Worker counted as its isolate's FIRST request cannot have
  // found the confirm module already evaluated. The module stamp calling one warm
  // means the cold population the bar above judged is missing it, so a pass there
  // could be a smaller population rather than a faster one (L457).
  if (cs !== null && cs.firstRequestsReadWarm > 0) {
    fail(
      "confirm startup",
      `${cs.firstRequestsReadWarm} confirm${cs.firstRequestsReadWarm === 1 ? " was its isolate's first request" : "s were their isolate's first request"} ` +
        "by the Worker's own count and the startup reading called " +
        `${cs.firstRequestsReadWarm === 1 ? "it" : "them"} warm, so the cold population this bar judges is ` +
        `missing ${cs.firstRequestsReadWarm === 1 ? "it" : "them"} (${cs.firstRequests} first requests among ` +
        `${cs.invocationIndexKnown} confirms with an invocation index, ${cs.cold} read as cold)`,
    );
  }

  // --- the fault pass ---------------------------------------------------------
  if (input.faultPass) {
    const fp = input.faultPass;
    // Judged on the requests it SENT (#3348): an attempt whose bucket's times could not
    // be read never reached the booking path, so it says nothing about how that path
    // held up under the fault.
    const sent = fp.attempts - fp.availabilityUnread;
    const keepsBar = faultPassKeepsFiveXxBar(fp.faultTargets);
    // Written as "not more than zero" so a count that never arrived (NaN) lands on the
    // refusal, never on the pass (L50).
    if (!(sent > 0)) {
      fail(
        "the fault pass",
        `it was configured at ${fp.faultPct} percent and sent no requests` +
          (fp.availabilityUnread > 0
            ? ` (all ${fp.availabilityUnread} were never sent because their bucket's times could not be read)`
            : "") +
          ", so it proved nothing",
      );
    } else {
      if (fp.fiveXx > 0 && keepsBar) {
        fail(
          "the fault pass",
          `${fp.fiveXx} of ${sent} requests were 5xx with ` +
            `${fp.faultTargets.join(", ")} failing ${fp.faultPct} percent of ` +
            "calls; the path must degrade, not error",
        );
      }
      // With only systems the path degrades around failing, the availability read must
      // still answer, exactly as it must in steady load. With one that fails loud by
      // design in the mix, the read meets that same designed failure, so the count is
      // reported beside the 5xx count instead (run-judge's fault pass line).
      if (fp.availabilityUnread > 0 && keepsBar) {
        fail(
          "fault pass requests never sent",
          `${fp.availabilityUnread} request${fp.availabilityUnread === 1 ? " was" : "s were"} never sent because ` +
            `the bucket's times could not be read with ${fp.faultTargets.join(", ")} failing ${fp.faultPct} ` +
            "percent of calls; the availability read must degrade, not fail",
        );
      }
    }
    // Cut short at the fault driver's own deadline (#3222): fewer requests than the
    // bar was sized for, so a clean count would read as a smaller clean pass.
    for (const d of input.faultPass.drivers ?? []) {
      if (!d.cutShort) continue;
      fail(
        "fault pass completed",
        `fault driver ${d.driver} stopped at its ${(d.cutShort.deadlineMs / 60_000).toFixed(1)} minute ` +
          `deadline after ${d.attempts.length} of ${d.planned} planned requests`,
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

  // #3294 review, L98: a void speed verdict on an otherwise clean run is
  // UNMEASURED, with its own non zero exit, never a pass; a real finding on any
  // other bar outranks it and the run fails.
  const speedVoid = speedUnmeasuredOf(m);
  const verdict: JudgeVerdict = findings.length > 0 ? "fail" : speedVoid !== null ? "unmeasured" : "pass";
  return {
    verdict,
    exit: JUDGE_EXIT[verdict],
    findings,
    measurements: m,
    speedUnmeasured: speedVoid,
    platformUnmeasured: null,
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
    speedUnmeasured: speedUnmeasuredOf(m),
    platformUnmeasured: why,
    incomplete: [],
  };
}
