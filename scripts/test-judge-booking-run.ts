// The verdict on a booking path load run (#2244), driven offline.
//
// A fixture per failure AND a passing one, which is the point: a judge with only
// failing fixtures is satisfied by one that fails on everything, and a judge with
// only a passing fixture is satisfied by one that passes on everything (L1). Every
// case below therefore starts from the SAME passing run and breaks exactly one
// thing, so each finding is attributable to the thing it names.
//
// Run: node --experimental-strip-types scripts/test-judge-booking-run.ts
import {
  judgeBookingRun,
  incompleteness,
  burstShortfall,
  percentiles,
  overlaps,
  JUDGE_EXIT,
  OK_P95_MS,
  FRESHNESS_MAX_SEC,
  CRON_CPU_MARGIN_SHARE,
  cronCpuShareText,
  BURST_LOSER_LAG_MS,
  burstsSummaryText,
  burstLegText,
  steadyLineText,
  waitSpanText,
  confirmWallText,
  lineSplitText,
  subrequestText,
  startupOriginText,
  coldAfterDeployText,
  resentText,
  RESENT_FAIL_AT,
  type JudgeInput,
  type JudgedBooking,
} from "./loadtest/judge-booking-run.ts";
import type { BookingAttempt, DriverResult } from "./loadtest/book-plan.ts";
import {
  idPrefix,
  burstCodeFor,
  externalIdFor,
  burstSettleAtMs,
  BURST_GRACE_DEFAULT_MS,
  REQUEST_TIMEOUT_MS,
} from "./loadtest/book-plan.ts";
import { readBurstProbe, readCrowdRule, type BurstProbe, type CrowdRuleReading } from "./loadtest/burst-probe.ts";
import {
  answeredAtEchoHeader,
  confirmLineEchoHeaders,
  readLoadtestEcho,
  type ConfirmLineEcho,
  type LoadtestEcho,
} from "../src/lib/loadtest-echo.ts";
import {
  BASELINE_BOOKINGS,
  BASELINE_MIN_OK,
  BASELINE_PER_MINUTE,
  BASELINE_PLANNED,
  BASELINE_WARMUP,
  LOAD_OVER_REST_RATIO_BAR,
  STEADY_P95_LIMIT_MS,
  latencyReportLine,
  baselineReading,
  verdictText,
  expectBaselineFrom,
} from "./loadtest/latency-bar.ts";
import { REQUEST_CPU_P99_MS, REQUEST_STARTUP_MS, faultPassCounts, faultPassReportLine } from "./loadtest/judge-booking-run.ts";
import {
  ceilingVerdict,
  exactAddressBound,
  CEILING_REFUSED_BY,
  type CeilingAttempt,
} from "./loadtest/preflight-checks.ts";
import { DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES } from "../src/lib/rate-limit-core.ts";
import { readConfirmStartup, type LineSplit } from "./loadtest/confirm-startup.ts";

/** A line split with nothing in it, which a case then fills in. */
function emptySplit(): LineSplit {
  return { traced: 0, joined: 0, missing: 0, impossible: 0, unreadable: 0, heldMs: [], objectMs: [], outsideMs: [] };
}
import { formatLine } from "../src/lib/log.ts";
import { healthyFaultLanes, fixtureLaneExpectations } from "./lib/fault-lanes-fixture.ts";
import { SYNC_FAILURE_ALERT_KEY } from "./loadtest/fault-lanes.ts";

/** When the fixture's fault window opens. Any instant: the lane judge reads only the
 *  series' own times. */
const LANES_T0 = Date.parse("2026-10-03T12:00:00Z");

/**
 * A confirm startup reading built by the REAL reader from REAL shaped tail lines,
 * so no fixture here can describe a state the reader cannot produce (L48).
 *
 * `cold` is a confirm that was its isolate's first request, and `warm` one that was
 * not. The reader decides which from the Worker's invocation index on the answer line
 * (#3418), so a row writes that index (0 cold, 6 warm) and a module stamp that agrees,
 * as a real first request's does. `stampCold` makes the stamp disagree, `index` sets
 * the count (null writes none, as an older deployment's line does), and an `answer`
 * carrying its own `isolate_invocation_index` keeps it.
 */
function startupReading(
  rows: {
    handlerMs: number;
    beforeMs: number;
    cold: boolean;
    stampCold?: boolean;
    index?: number | null;
    afterMs?: number;
    answer?: Record<string, number | string>;
  }[],
  opts?: Parameters<typeof readConfirmStartup>[1],
) {
  const lines = rows.map((r) => {
    const index = r.index === undefined ? (r.cold ? 0 : 6) : r.index;
    const answer =
      index === null
        ? r.answer
        : { isolate_invocation_index: index, ...(r.answer ?? {}) };
    const stampCold = r.stampCold ?? r.cold;
    return JSON.stringify({
      outcome: "ok",
      eventTimestamp: 0,
      cpuTime: r.handlerMs,
      // The invocation carries on after the profile is logged, which is where the
      // 2026-09-14 run's expensive confirms actually spent their time.
      wallTime: r.beforeMs + r.handlerMs + (r.afterMs ?? 200),
      logs: [
        {
          level: "info",
          timestamp: r.beforeMs + r.handlerMs,
          message: [
            formatLine("confirm-profile", {
              msg: "where the confirm spent its wall time",
              total_ms: r.handlerMs,
              isolate_age_ms: stampCold ? Math.max(0, r.beforeMs - 1) : r.beforeMs + 1,
            }),
          ],
        },
        // #3354: the invocation's own answer line, when the fixture carries one.
        ...(answer
          ? [{ level: "info", timestamp: r.beforeMs + r.handlerMs + 1, message: [formatLine("booking-api", { msg: "confirm answered", response_ms: 2_000, status: 200, ...answer })] }]
          : []),
      ],
    }, null, 4);
  });
  return readConfirmStartup(lines.join("\n"), opts);
}

/** The app's own exact per address bound, so these fixtures cannot describe a
 *  state the control can never produce (L48). */
const CEILING_EXACT_BOUND = exactAddressBound(DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES)!;
import { AVAILABILITY_UNREAD, NO_SLOTS_OFFERED } from "./loadtest/outcomes.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const RUN = "run-1";
const T0 = Date.parse("2026-09-15T14:00:00.000Z");

/**
 * What the deployment echoed on one response (#3325), built by the deployment's OWN
 * builders and read back through the driver's OWN parser, so no fixture here can
 * hold an echo the driver could never record (L48). `line` null sends no line
 * headers at all, which is what a deployment without the shared line sends; `at`
 * null sends no answer stamp.
 */
function echoOf(line: Partial<ConfirmLineEcho> | null, at: number | null): LoadtestEcho {
  const pairs: [string, string][] = [];
  if (line) pairs.push(...confirmLineEchoHeaders({ line: "shared", reason: "ok", key: "ladder", lineMs: 40, ...line }));
  if (at !== null) pairs.push(answeredAtEchoHeader(at));
  return readLoadtestEcho(new Headers(pairs));
}
const TARGET = { drivers: 4, perDriverPerMinute: 15, minutes: 10 };
/** When the base fixture's burst fired, on the deployment's clock. */
const BURST_AT = Date.parse("2026-09-15T13:50:00.000Z");
const PER_DRIVER = TARGET.perDriverPerMinute * TARGET.minutes;

/**
 * #3429: what a burst driver read of the deployment's crowd rule, through the driver's
 * OWN reader over a version body in the route's shape, so no fixture can hold a rule
 * the driver could never record (L48).
 */
function crowdRuleOf(rule: string | undefined): CrowdRuleReading {
  return readCrowdRule(200, {
    commit: "abc1234",
    loadtest: true,
    faultPct: 0,
    ...(rule === undefined ? {} : { confirmCrowdRule: rule }),
  });
}

/**
 * #3429: one driver's probe of a burst's slot, sent `afterMs` past the moment the burst
 * settled (on the run's own defaults), read through the driver's own reader from a body
 * in `/api/bookings/bookable`'s shape.
 */
function probeOf(
  code: string,
  momentMs: number,
  answer: { bookable: boolean; reason: string; rungsDropped?: number; effective?: string | null },
  afterMs = 1_000,
): BurstProbe {
  return readBurstProbe({
    code,
    sentAtMs: burstSettleAtMs(momentMs, BURST_GRACE_DEFAULT_MS, REQUEST_TIMEOUT_MS) + afterMs,
    status: 200,
    body: {
      bookable: answer.bookable,
      reason: answer.reason,
      requestedBucketCode: code,
      effectiveBucketCode: answer.effective ?? (answer.bookable ? code : null),
      tierFallback: (answer.rungsDropped ?? 0) > 0,
      rungsDropped: answer.rungsDropped ?? 0,
      wouldAssign: answer.bookable ? { id: "agent-x", name: null, email: null } : null,
    },
  });
}

function attempt(driver: number, n: number, over: Partial<BookingAttempt> = {}): BookingAttempt {
  return {
    driver,
    n,
    code: "112",
    externalId: `${RUN}-${driver}-${n}`,
    sentAtMs: T0 + n * 4000,
    wallMs: 400,
    status: 200,
    outcome: "booked",
    // Each attempt gets its OWN slot, an hour apart per driver, so the passing
    // fixture carries no accidental overlap of its own.
    startIso: new Date(T0 + 86_400_000 + (driver * 1000 + n) * 20 * 60_000).toISOString(),
    seenIp: "203.0.113.9",
    // Served by the shared line, as a load run expects (#3325), and stamped when the
    // deployment answered.
    echo: echoOf({}, T0 + n * 4000 + 400),
    ...over,
  };
}

function driverFile(driver: number, over: Partial<DriverResult> = {}): DriverResult {
  return {
    runId: RUN,
    driver,
    mode: "steady",
    planned: PER_DRIVER,
    startedAtMs: T0,
    finishedAtMs: T0 + TARGET.minutes * 60_000,
    attempts: Array.from({ length: PER_DRIVER }, (_, n) => attempt(driver, n)),
    ...over,
  };
}

function bookingFor(a: BookingAttempt, over: Partial<JudgedBooking> = {}): JudgedBooking {
  const starts = a.startIso!;
  return {
    id: `bk-${a.externalId}`,
    external_id: a.externalId,
    idempotency_key: `key-${a.externalId}`,
    // One agent per driver, so the passing fixture's bookings cannot collide
    // across drivers either.
    assigned_user_id: `agent-${a.driver}`,
    starts_at: starts,
    ends_at: new Date(Date.parse(starts) + 20 * 60_000).toISOString(),
    status: "confirmed",
    ...over,
  };
}

/** The passing run, built once so every case below is one deliberate break from it. */
function passing(): JudgeInput {
  const driverResults = [0, 1, 2, 3].map((d) => driverFile(d));
  // The burst's answers, stamped on the deployment's clock (#3325): the winner at
  // BURST_AT + 800ms and every loser within half a second of it.
  const burstWinner = attempt(9, 0, {
    code: "122",
    startIso: "2026-09-16T15:00:00.000Z",
    echo: echoOf({}, BURST_AT + 800),
  });
  const burstResults: DriverResult[] = [
    {
      runId: RUN,
      driver: 9,
      mode: "burst",
      planned: 25,
      startedAtMs: T0,
      finishedAtMs: T0 + 2000,
      burstLeg: { index: 0, of: 1, slot: "2026-09-16T15:00:00.000Z", codes: ["122"], startAtMs: BURST_AT },
      // #3429: the deployment's crowd rule, and the slot probed once the burst had
      // settled: the ladder spent, so every SLOT_TAKEN below was honest.
      crowdRule: crowdRuleOf("walks"),
      probe: probeOf("122", BURST_AT, { bookable: false, reason: "slot_taken" }),
      attempts: [
        burstWinner,
        ...Array.from({ length: 24 }, (_, i) =>
          attempt(9, i + 1, {
            code: "122",
            startIso: "2026-09-16T15:00:00.000Z",
            status: 409,
            outcome: "SLOT_TAKEN",
            echo: echoOf({}, BURST_AT + 800 + (i + 1) * 20),
          }),
        ),
      ],
    },
  ];
  const bookings = [
    ...driverResults.flatMap((r) => r.attempts.map((a) => bookingFor(a))),
    bookingFor(burstWinner, { assigned_user_id: "agent-beyond" }),
  ];
  return {
    runId: RUN,
    target: TARGET,
    driverResults,
    burstResults,
    freshnessSamples: Array.from({ length: TARGET.minutes }, (_, i) => ({
      minute: i + 1,
      maxAgeSec: 90,
      total: 60,
    })),
    bookings,
    bookingIdsWithBusyBlock: bookings.map((b) => b.id),
    slotUniqueIndexPresent: true,
    overlapConstraintPresent: true,
    // Built by the REAL verdict function from a plausible status list, so the
    // fixture cannot describe a state the control can never produce (L48).
    ipCeilingControl: ceilingVerdict(
      [
        ...Array(64).fill({ status: 200, seenIp: "203.0.113.9", refusedBy: null }),
        ...Array(116).fill({
          status: 429,
          seenIp: "203.0.113.9",
          refusedBy: CEILING_REFUSED_BY.address,
        }),
      ] as CeilingAttempt[],
      60,
      CEILING_EXACT_BOUND,
    ),
    // A healthy split: warm confirms carrying the framework's own overhead, and
    // cold ones inside what is left of the latency bar.
    confirmStartup: startupReading([
      ...Array.from({ length: 40 }, () => ({ handlerMs: 900, beforeMs: 500, cold: false })),
      ...Array.from({ length: 3 }, () => ({ handlerMs: 900, beforeMs: 1_200, cold: true })),
    ]),
    platform: {
      invocations: 610,
      cpuMsP99: 40,
      subrequests: 52_000,
      statuses: { success: 610 },
      // No cron fired inside the window, which is what makes the adaptive
      // percentile request only and so judgeable against the per request budget.
      // `agreed-empty` because a zero is only a reading when BOTH the analytics
      // dataset and the run's own archived log say so (#2352): that dataset alone
      // has never once reported a tick for a load test Worker.
      cron: { invocations: 0, worstCpuMs: 0, byCron: {} },
      cronSource: "agreed-empty" as const,
    },
    faultPass: { attempts: 100, availabilityUnread: 0, fiveXx: 0, faultPct: 10, faultTargets: ["google-read"] },
    // #3104: the lanes kept running and the sync page fired once while faulted.
    faultLanes: { evidence: healthyFaultLanes(LANES_T0, RUN), expectations: fixtureLaneExpectations(LANES_T0) },
    expectedLegs: { burstDrivers: burstResults.length, bursts: 1, faultPct: 10 },
    unreadableDriverFiles: [],
    budgets: { cpuMsP99: REQUEST_CPU_P99_MS, cronCpuMs: 120_000 },
  };
}

// --- the passing run really passes -------------------------------------------

{
  const r = judgeBookingRun(passing());
  eq(
    `${r.verdict} ${r.findings.map((f) => f.bar).join("|")}`,
    "pass ",
    "a healthy run passes with no findings",
  );
  eq(r.exit, JUDGE_EXIT.pass, "and exits zero");
  eq(r.measurements!.confirmed, 4 * PER_DRIVER, "every request was confirmed");
  eq(r.measurements!.confirmedPerMinute, 60, "which is sixty a minute");
}

/** Judge a run built by breaking the passing one in exactly one way. */
function broken(mutate: (i: JudgeInput) => void) {
  const input = passing();
  mutate(input);
  return judgeBookingRun(input);
}
const bars = (r: ReturnType<typeof judgeBookingRun>) => r.findings.map((f) => f.bar);

// --- it refuses to judge an incomplete run BEFORE computing anything ----------

{
  // The decision the whole file rests on. Three drivers of four is computable and
  // every rate looks plausible; nothing in the numbers says a quarter is missing.
  const r = broken((i) => i.driverResults.pop());
  eq(r.verdict, "incomplete", "a missing driver file is incomplete, not a failure");
  eq(r.exit, JUDGE_EXIT.incomplete, "on its own exit code");
  eq(r.measurements, null, "and NOTHING is measured, so no rate can be quoted from a partial run");
  assert(r.incomplete[0]!.includes("3 driver"), "the reason names what was missing");
}

{
  const short = broken((i) => {
    i.driverResults[0]!.attempts = i.driverResults[0]!.attempts.slice(0, 10);
  });
  eq(short.verdict, "incomplete", "a driver that recorded fewer attempts than planned is incomplete");

  const wrongRun = broken((i) => {
    i.driverResults[1]!.runId = "some-other-run";
  });
  eq(wrongRun.verdict, "incomplete", "and so is a file from a different run");

  const dup = broken((i) => {
    i.driverResults[2]!.driver = 0;
  });
  eq(dup.verdict, "incomplete", "and two files claiming one driver number");

  const fewSamples = broken((i) => {
    i.freshnessSamples = i.freshnessSamples.slice(0, 2);
  });
  eq(
    fewSamples.verdict,
    "incomplete",
    "and a sampler that stopped early, because a short window never reaches the age a full one does",
  );

  // A burst driver that missed its moment FAILS the burst (#3222). It used to make
  // the run incomplete, and the workflow skipped the whole steady pass behind the
  // failed burst job, so one late driver cost the run every figure it had. The
  // contention bar is not asked of a burst that was not simultaneous ("exactly one
  // 200" would be answered by however many drivers arrived); the burst fails with
  // its reason and the steady figures are judged beside it.
  const missed = broken((i) => {
    i.burstResults[0]!.burstSkipped = "missed";
    i.burstResults[0]!.attempts = [];
  });
  eq(missed.verdict, "fail", "a burst driver that did not fire fails the burst");
  eq(bars(missed), ["the burst"], "and nothing else: the steady pass is judged and passes");
  assert(
    missed.findings[0]!.detail.includes("did not fire (missed)"),
    `with its reason (got: ${missed.findings[0]?.detail})`,
  );
  assert(missed.measurements !== null, "and the steady figures are measured beside it");
}

// --- a slow run is judged, a silent driver is not (#3222) -------------------------

/**
 * Driver 2 stopped at its own deadline after `made` requests, every one of them
 * slow, the way run 37215457763's drivers were: p95 about 8s against a 5s bar.
 * Its file is the well formed partial one the driver writes, and the bookings it
 * never got to are absent from the database exactly as they would be.
 */
/** One fault driver's file, cut short after `made` of a thirty request plan, or not. */
function faultFiles(made: number, cutShort = true): { drivers: DriverResult[]; expectedPerDriver: number } {
  return {
    expectedPerDriver: 30,
    drivers: [
      {
        runId: RUN,
        driver: 0,
        mode: "fault",
        planned: 30,
        startedAtMs: T0,
        finishedAtMs: T0 + 180_000,
        faultPct: 10,
        faultTargets: ["google-read"],
        ...(cutShort ? { cutShort: { deadlineMs: 180_000, attemptsMade: made } } : {}),
        attempts: Array.from({ length: made }, (_, n) => attempt(0, n, { externalId: `${RUN}-f-0-${n}` })),
      },
    ],
  };
}

function slowRun(made = 100): JudgeInput {
  const input = passing();
  for (const r of input.driverResults) for (const a of r.attempts) a.wallMs = 8_000;
  const d2 = input.driverResults[2]!;
  d2.attempts = d2.attempts.slice(0, made);
  d2.cutShort = { deadlineMs: 15 * 60_000, attemptsMade: made };
  const kept = new Set(input.driverResults.flatMap((r) => r.attempts.map((a) => a.externalId)));
  input.bookings = input.bookings.filter(
    (b) => !b.external_id?.startsWith(`${RUN}-2-`) || kept.has(b.external_id),
  );
  return input;
}

{
  const r = judgeBookingRun(slowRun());
  eq(r.verdict, "fail", "a driver cut short by its own deadline is a FAIL, not an incomplete run");
  eq(r.exit, JUDGE_EXIT.fail, "on the failure exit code");
  eq(r.incomplete, [], "with nothing reported as incomplete");
  assert(r.measurements !== null, "and the run IS measured, so the figures reach the report");
  const share = r.findings.find((f) => f.bar === "planned bookings completed");
  assert(share !== undefined, "the share of the plan that ran is its own finding");
  assert(
    share?.detail.includes("driver 2") === true && share.detail.includes("100 of 150"),
    `it names the driver and how far it got (got: ${share?.detail})`,
  );
  assert(
    share?.detail.includes("550 of 600") === true && share.detail.includes("91.7%"),
    `and the share of the whole run that completed (got: ${share?.detail})`,
  );
  const latency = r.findings.find((f) => f.bar === "latency of successful bookings");
  assert(
    latency?.detail.includes("p95 8000ms") === true,
    `the latency bar is scored on what ran (got: ${latency?.detail})`,
  );
  eq(r.measurements!.planned, 4 * PER_DRIVER, "the measurements carry what was planned");
  eq(r.measurements!.attempts, 3 * PER_DRIVER + 100, "beside what was made");
  eq(r.measurements!.cutShort, [{ driver: 2, made: 100, planned: PER_DRIVER, deadlineMs: 15 * 60_000 }], "and which driver stopped");
}

{
  // The control the FAIL above rests on: the same run with no driver cut short
  // fails only its latency bar, so the share finding is caused by the cut short.
  const input = passing();
  for (const r of input.driverResults) for (const a of r.attempts) a.wallMs = 8_000;
  const r = judgeBookingRun(input);
  eq(bars(r), ["latency of successful bookings"], "a slow run that finished fails latency alone");
}

{
  // A driver that wrote NOTHING hung or crashed: a slow one stops itself and
  // writes what it ran. Still incomplete, and the reason names which driver.
  const r = broken((i) => {
    i.driverResults.splice(2, 1);
  });
  eq(r.verdict, "incomplete", "a missing driver file is still incomplete");
  assert(
    r.incomplete.some((w) => w.includes("driver 2 wrote no result file")),
    `and the reason names the driver that wrote nothing (got: ${r.incomplete.join(" | ")})`,
  );
}

{
  // A cut short file that does not agree with itself is not a partial run, it is
  // a file nobody can read, and it stays incomplete.
  const mismatched = slowRun();
  mismatched.driverResults[2]!.cutShort!.attemptsMade = 120;
  eq(judgeBookingRun(mismatched).verdict, "incomplete", "a cut short file whose count disagrees is incomplete");
  const overPlan = slowRun();
  overPlan.driverResults[2]!.planned = 90;
  eq(judgeBookingRun(overPlan).verdict, "incomplete", "and so is one claiming a different plan from the run's");
}

{
  // The fault driver keeps the same deadline. A pass it cut short sent fewer
  // requests than the bar was sized for, so it fails with its figures rather
  // than reading as a clean, smaller pass.
  const r = broken((i) => {
    i.faultPass = { ...i.faultPass!, ...faultFiles(20) };
  });
  const f = r.findings.find((x) => x.bar === "fault pass completed");
  assert(f?.detail.includes("20 of 30") === true, `a cut short fault pass fails with its figures (got: ${f?.detail})`);
  eq(r.verdict, "fail", "and the run fails");
  eq(judgeBookingRun({ ...passing(), faultPass: { ...passing().faultPass!, ...faultFiles(30, false) } }).verdict, "pass", "control: a whole fault file passes");
}

{
  // The SAME file checks the steady drivers get, applied to the fault driver: a
  // cut short file that disagrees with itself, and a file short of its plan with
  // no word of why, are not a partial run anybody can read.
  const mismatched = faultFiles(20);
  mismatched.drivers[0]!.cutShort!.attemptsMade = 25;
  assert(
    incompleteness({ ...passing(), faultPass: { ...passing().faultPass!, ...mismatched } }).some((w) =>
      w.includes("fault driver 0 says it was cut short"),
    ),
    "a fault file whose cut short count disagrees is incomplete",
  );
  const silentShort = faultFiles(20, false);
  assert(
    incompleteness({ ...passing(), faultPass: { ...passing().faultPass!, ...silentShort } }).some((w) =>
      w.includes("fault driver 0 recorded 20 attempts, expected 30"),
    ),
    "and so is a fault file short of its plan that does not say it was cut short",
  );
  const otherPlan = faultFiles(20);
  otherPlan.drivers[0]!.planned = 40;
  assert(
    incompleteness({ ...passing(), faultPass: { ...passing().faultPass!, ...otherPlan } }).some((w) =>
      w.includes("fault driver 0 was cut short against a plan of 40"),
    ),
    "and one cut short against a different plan from the run's",
  );
}

{
  // A driver with no steady file is named by its CAUSE (#3222). A file that could
  // not be read and a file in the wrong mode are not a driver that hung, and each
  // sends a reader somewhere different (L11).
  const unreadable = broken((i) => {
    i.driverResults.splice(1, 1);
    i.unreadableDriverFiles = [{ file: "driver-1.json", why: "Unexpected end of JSON input" }];
  });
  assert(
    unreadable.incomplete.some((w) => w.includes("driver-1.json could not be read") && w.includes("Unexpected end")),
    `an unreadable file is named as unreadable (got: ${unreadable.incomplete.join(" | ")})`,
  );
  assert(!unreadable.incomplete.some((w) => w.includes("hung")), "and not as a driver that hung");
  const wrongMode = broken((i) => {
    i.driverResults.splice(3, 1);
    i.unreadableDriverFiles = [{ file: "driver-3.json", why: "it says mode burst, not steady" }];
  });
  assert(
    wrongMode.incomplete.some((w) => w.includes("driver-3.json") && w.includes("mode burst")),
    "a file in the wrong mode is named as that",
  );
  const absent = broken((i) => {
    i.driverResults.splice(0, 1);
  });
  assert(
    absent.incomplete.some((w) => w.includes("driver 0 wrote no result file")),
    "and only a file that never arrived at all is the silent driver",
  );
}

{
  // A request the driver gave up on at its own bound is its own finding, apart
  // from one the deployment never answered for another reason (L11).
  const r = broken((i) => {
    const a = i.driverResults[0]!.attempts[3]!;
    a.status = 0;
    a.outcome = "timed-out";
  });
  const f = r.findings.find((x) => x.bar === "timed out requests");
  assert(f?.detail.includes("1 request") === true, `a timed out request is its own bar (got: ${f?.detail})`);
  assert(!bars(r).includes("unanswered requests"), "and is not also counted as unanswered");
  eq(r.measurements!.timedOut, 1, "and is measured");
}

// --- throughput ----------------------------------------------------------------

{
  const r = broken((i) => {
    for (const a of i.driverResults[0]!.attempts) {
      a.status = 409;
      a.outcome = "SLOT_TAKEN";
    }
    for (const a of i.driverResults[1]!.attempts) {
      a.status = 409;
      a.outcome = "SLOT_TAKEN";
    }
    i.bookings = i.bookings.filter((b) => !b.external_id?.startsWith(`${RUN}-0-`) && !b.external_id?.startsWith(`${RUN}-1-`));
    i.bookingIdsWithBusyBlock = i.bookings.map((b) => b.id);
  });
  assert(bars(r).includes("confirmed bookings per minute"), "half the run refused is under the floor");
  assert(
    r.findings.find((f) => f.bar === "confirmed bookings per minute")!.detail.includes("SLOT_TAKEN"),
    "and the full outcome mix is printed, so a reader sees WHY rather than only that it was short",
  );
}

// --- latency --------------------------------------------------------------------

{
  const slow = broken((i) => {
    // The slowest tenth, so the p95 moves and the p50 does not: the bar is about
    // the tail, and a fixture that made everything slow would pass a judge reading
    // the median.
    const all = i.driverResults.flatMap((r) => r.attempts);
    for (const a of all.slice(0, Math.ceil(all.length * 0.1))) a.wallMs = OK_P95_MS + 1000;
  });
  assert(bars(slow).includes("latency of successful bookings"), "a slow tail fails the p95 bar");

  const errored = broken((i) => {
    i.driverResults[0]!.attempts[0]!.status = 500;
    i.driverResults[0]!.attempts[0]!.outcome = "INTERNAL";
    i.bookings = i.bookings.filter((b) => b.external_id !== `${RUN}-0-0`);
    i.bookingIdsWithBusyBlock = i.bookings.map((b) => b.id);
  });
  assert(bars(errored).includes("server errors"), "one 5xx is a finding");

  const silent = broken((i) => {
    i.driverResults[0]!.attempts[0]!.status = 0;
    i.driverResults[0]!.attempts[0]!.outcome = "transport: TypeError";
    i.bookings = i.bookings.filter((b) => b.external_id !== `${RUN}-0-0`);
    i.bookingIdsWithBusyBlock = i.bookings.map((b) => b.id);
  });
  assert(bars(silent).includes("unanswered requests"), "and a request that got no reply is another");
  assert(
    !bars(silent).includes("server errors"),
    "kept APART from a 5xx, because they send two different people to two different places",
  );

  // A bucket offering nothing is recorded with status 0 too, and must NOT be
  // counted as an unanswered request: nothing was ever sent.
  const noSlots = broken((i) => {
    i.driverResults[0]!.attempts[0]!.status = 0;
    i.driverResults[0]!.attempts[0]!.outcome = NO_SLOTS_OFFERED;
    i.bookings = i.bookings.filter((b) => b.external_id !== `${RUN}-0-0`);
    i.bookingIdsWithBusyBlock = i.bookings.map((b) => b.id);
  });
  assert(
    !bars(noSlots).includes("unanswered requests"),
    "a bucket that offered nothing is not an unanswered request",
  );

  // #3348: a request never sent because its bucket's times could not be read at all
  // is neither an unanswered request nor a bucket offering nothing. It fails on its
  // own bar: the run did not drive the load it planned, and says why.
  const unread = broken((i) => {
    i.driverResults[0]!.attempts[0]!.status = 0;
    i.driverResults[0]!.attempts[0]!.outcome = AVAILABILITY_UNREAD;
    i.bookings = i.bookings.filter((b) => b.external_id !== `${RUN}-0-0`);
    i.bookingIdsWithBusyBlock = i.bookings.map((b) => b.id);
  });
  assert(!bars(unread).includes("unanswered requests"), "an unread availability read is not an unanswered request");
  assert(bars(unread).includes("requests never sent"), `it fails on its own bar (got ${JSON.stringify(bars(unread))})`);
  assert(!bars(noSlots).includes("requests never sent"), "and a bucket offering nothing does not trip it");
}

// --- the invariant the run exists to protect ------------------------------------

{
  const clash = broken((i) => {
    // Two active bookings for ONE agent at overlapping times.
    i.bookings.push({
      id: "bk-clash",
      external_id: "clash",
      idempotency_key: "k",
      assigned_user_id: "agent-0",
      starts_at: i.bookings[0]!.starts_at,
      ends_at: i.bookings[0]!.ends_at,
      status: "confirmed",
    });
    i.bookingIdsWithBusyBlock = i.bookings.map((b) => b.id);
  });
  assert(bars(clash).includes("double bookings"), "two active bookings overlapping on one agent");

  // A CANCELLED booking in the same window is not a clash: it holds no slot.
  const cancelled = broken((i) => {
    i.bookings.push({
      id: "bk-cancelled",
      external_id: "cancelled",
      idempotency_key: "k",
      assigned_user_id: "agent-0",
      starts_at: i.bookings[0]!.starts_at,
      ends_at: i.bookings[0]!.ends_at,
      status: "cancelled",
    });
    i.bookingIdsWithBusyBlock = i.bookings.map((b) => b.id);
  });
  assert(!bars(cancelled).includes("double bookings"), "a cancelled booking holds no slot");

  // The judge is told whether the index really ENFORCES, by the preflight planting
  // a duplicate and seeing the database refuse it, rather than by a catalogue
  // lookup. The lookup it used to do asked PostgREST for `pg_indexes`, which
  // PostgREST does not expose: that read answers 404 everywhere, so this bar
  // reported the index missing on EVERY run and would have been muted by the second
  // week (L36). It is also the weaker question: an index present but not enforcing
  // reads as fine to a name lookup (L63).
  const noIndex = broken((i) => {
    i.slotUniqueIndexPresent = false;
  });
  assert(
    bars(noIndex).includes("bookings_active_slot_uniq"),
    "an index never shown to enforce is a finding on its own, because without it an absence of " +
      "overlaps proves nothing",
  );
}

// --- every 200 left a row behind -------------------------------------------------

{
  const ghost = broken((i) => {
    i.bookings = i.bookings.filter((b) => b.external_id !== `${RUN}-2-5`);
    i.bookingIdsWithBusyBlock = i.bookings.map((b) => b.id);
  });
  assert(bars(ghost).includes("a 200 with no booking row"), "a 200 that created nothing");

  const noKey = broken((i) => {
    i.bookings[3]!.idempotency_key = null;
  });
  assert(bars(noKey).includes("idempotency key"), "a booking row with no idempotency key");

  const noBlock = broken((i) => {
    i.bookingIdsWithBusyBlock = i.bookingIdsWithBusyBlock.slice(1);
  });
  assert(
    bars(noBlock).includes("busy_blocks write-through"),
    "an active booking with no busy_blocks row, whose slot still reads free",
  );
}

// --- the burst --------------------------------------------------------------------

{
  // The bar is ONE WINNER PER AGENT, not one winner (#2261). "Exactly one" was a
  // proxy for the burst code's pool being one agent deep, which the seed does not
  // guarantee: a live run answered two 200s at one slot and they went to two
  // DIFFERENT agents, which is the unique index working exactly as specified.
  const twoOnOneAgent = broken((i) => {
    const a = i.burstResults[0]!.attempts[1]!;
    a.status = 200;
    a.outcome = "booked";
    // The SAME agent as the base fixture's winner, which is the state
    // `bookings_active_slot_uniq` exists to make impossible.
    i.bookings.push(bookingFor(a, { assigned_user_id: "agent-beyond" }));
    i.bookingIdsWithBusyBlock = i.bookings.map((b) => b.id);
  });
  assert(
    bars(twoOnOneAgent).includes("the burst's winners"),
    "two winners resolving to ONE agent is the unique index not holding",
  );

  const twoOnTwoAgents = broken((i) => {
    const a = i.burstResults[0]!.attempts[1]!;
    a.status = 200;
    a.outcome = "booked";
    i.bookings.push(bookingFor(a, { assigned_user_id: "agent-beyond-2" }));
    i.bookingIdsWithBusyBlock = i.bookings.map((b) => b.id);
  });
  assert(
    !bars(twoOnTwoAgents).some((b) => b.startsWith("the burst")),
    "and two winners on two different agents is a deeper pool, not a defect",
  );

  const wrongRefusal = broken((i) => {
    const a = i.burstResults[0]!.attempts[1]!;
    a.status = 429;
    a.outcome = "RATE_LIMITED";
  });
  assert(
    bars(wrongRefusal).includes("the burst's losers"),
    "a loser refused for a reason OTHER than the slot being taken: the control counted contention " +
      "that was really the rate limiter",
  );

  // A run with no burst leg CONFIGURED. This used to leave the expectation at one
  // driver, which made the run incomplete and the assertion pass over no findings
  // at all; a configured leg that never arrived now fails the burst (#3222).
  const noBurst = broken((i) => {
    i.burstResults = [];
    i.expectedLegs = { ...i.expectedLegs, burstDrivers: 0 };
  });
  eq(noBurst.verdict, "pass", "a run with no burst leg configured passes on everything else");
  assert(
    !bars(noBurst).some((b) => b.startsWith("the burst")),
    "a run with no burst leg is judged on everything else rather than failing for its absence",
  );
}

// --- freshness ----------------------------------------------------------------------

{
  const stale = broken((i) => {
    i.freshnessSamples[4]!.maxAgeSec = FRESHNESS_MAX_SEC + 30;
  });
  assert(
    bars(stale).includes("recompute freshness under load"),
    "ONE sample over the bar is enough: the run reports the worst age it measured, not the average",
  );
}

// --- a lead on a cold isolate, judged apart from the confirm itself (#2340) ----------
//
// The bar the platform's CPU percentile could not express. That percentile is one
// number per invocation with nothing in it saying whether the invocation also paid
// for the isolate, so run 34889873261 failed it at 2,988ms over 1,364 invocations
// while the expensive confirms were doing no more confirm work than the cheap ones.
{
  const healthy = judgeBookingRun(passing());
  assert(
    !bars(healthy).includes("confirm startup"),
    "warm overhead and a cold start inside what is left of the latency bar is a pass",
  );
  eq(healthy.measurements!.confirmSamples, 43, "and the two halves are reported, over a denominator");
  eq(healthy.measurements!.confirmCold, 3, "with how many of them were the isolate's first");
  eq(healthy.measurements!.confirmHandler!.p95, 900, "the confirm's own time");
  eq(healthy.measurements!.confirmColdStartup!.p95, 1_200, "and the startup, kept apart from it");
  eq(
    healthy.measurements!.confirmAfterResponse!.p95,
    200,
    "and what the invocation did AFTER the response had gone, which is a third span and " +
      "not part of either: no lead waits for it and the CPU bar still counts it",
  );

  const slow = broken((i) => {
    i.confirmStartup = startupReading([
      ...Array.from({ length: 40 }, () => ({ handlerMs: 900, beforeMs: 500, cold: false })),
      ...Array.from({ length: 3 }, () => ({ handlerMs: 900, beforeMs: 4_000, cold: true })),
    ]);
  });
  assert(
    bars(slow).includes("confirm startup"),
    `a cold start over the ${REQUEST_STARTUP_MS}ms left of the latency bar is a finding`,
  );
  // Dan, 2026-10-16: the bar holds EVERY cold confirm, as #3353 planned it. Read as a p95
  // it meant the slowest at ten cold confirms and the second slowest at twenty two, so run
  // 38933668981 passed with one cold confirm waiting 4562ms on a p95 of 1699ms.
  const oneSlowOfMany = broken((i) => {
    i.confirmStartup = startupReading([
      ...Array.from({ length: 40 }, () => ({ handlerMs: 900, beforeMs: 500, cold: false })),
      ...Array.from({ length: 21 }, () => ({ handlerMs: 900, beforeMs: 1_200, cold: true })),
      { handlerMs: 900, beforeMs: 4_562, cold: true },
    ]);
  });
  assert(oneSlowOfMany.measurements!.confirmColdStartup!.p95 < REQUEST_STARTUP_MS, "control: the cold p95 is under the bar");
  assert(bars(oneSlowOfMany).includes("confirm startup"), "and one cold confirm over the bar still fails it, however many are under");
  const oneDetail = oneSlowOfMany.findings.find((f) => f.bar === "confirm startup")!.detail;
  assert(/slowest/.test(oneDetail) && /4562ms/.test(oneDetail), `and the finding names the slowest wait (got: ${oneDetail})`);
  const allUnder = broken((i) => {
    i.confirmStartup = startupReading([
      ...Array.from({ length: 40 }, () => ({ handlerMs: 900, beforeMs: 500, cold: false })),
      ...Array.from({ length: 22 }, () => ({ handlerMs: 900, beforeMs: 2_400, cold: true })),
    ]);
  });
  assert(!bars(allUnder).includes("confirm startup"), "every cold confirm under the bar passes it");
  const slowDetail = slow.findings.find((f) => f.bar === "confirm startup")!.detail;
  assert(/cold isolate/.test(slowDetail), "and the detail says what a lead actually met");
  assert(
    /warm/.test(slowDetail),
    "beside the warm number, because the gap between the two is the whole reading",
  );
  // #3354: the finding used to name the cause ("the server bundle being evaluated")
  // without having measured it, and run 37390071571 showed the confirm line and auth
  // in that wait too (L11). It now points at the measured split instead.
  assert(!/server bundle/.test(slowDetail), `and it claims no cause it did not measure (got: ${slowDetail})`);
  assert(/span line/.test(slowDetail), `and it points at the report's span line, which splits the wait (got: ${slowDetail})`);
  // #3436: the list of where the wait can go names the isolate's own start first, which
  // on run 37520312761 was the biggest piece of the miss and was in no span.
  assert(/the isolate starting before the Worker's entry, then route, auth/.test(slowDetail), `and it names the isolate's own start among the spans (got: ${slowDetail})`);
  // The verdict is still read from the whole wait before the profile, which already
  // begins at the invocation's start: the same slow cold confirms with no entry stamp
  // at all fail the bar exactly as before, so a missing stamp never moves the verdict.
  const unstampedSlow = broken((i) => {
    i.confirmStartup = startupReading([
      ...Array.from({ length: 40 }, () => ({ handlerMs: 900, beforeMs: 500, cold: false })),
      ...Array.from({ length: 3 }, () => ({ handlerMs: 900, beforeMs: 4_000, cold: true, answer: { wait_total_ms: 3_000 } })),
    ]);
  });
  const stampedSlow = broken((i) => {
    i.confirmStartup = startupReading([
      ...Array.from({ length: 40 }, () => ({ handlerMs: 900, beforeMs: 500, cold: false })),
      ...Array.from({ length: 3 }, () => ({ handlerMs: 900, beforeMs: 4_000, cold: true, answer: { wait_total_ms: 3_000, wait_entry_at_ms: 1_000 } })),
    ]);
  });
  eq(
    unstampedSlow.findings.find((f) => f.bar === "confirm startup")?.detail,
    stampedSlow.findings.find((f) => f.bar === "confirm startup")?.detail,
    "the bar's finding is the same with or without the entry stamp: the span is reported, never judged",
  );

  // #3418: the bar judges the confirms the WORKER counted as their isolate's first
  // request, never the module stamp's. A slow confirm the stamp alone calls cold (the
  // first confirm on an isolate that had already run the app) is warm, so it cannot fail
  // the bar; the same confirm counted 0 by the Worker does.
  const plainWarm = Array.from({ length: 40 }, () => ({ handlerMs: 900, beforeMs: 500, cold: false }));
  const firstThree = Array.from({ length: 3 }, () => ({ handlerMs: 900, beforeMs: 1_200, cold: true }));
  const stampOnly = broken((i) => {
    i.confirmStartup = startupReading([...plainWarm, ...firstThree, { handlerMs: 900, beforeMs: 4_000, cold: false, stampCold: true, index: 1 }]);
  });
  assert(
    !bars(stampOnly).includes("confirm startup"),
    "a slow confirm only the module stamp calls cold is not judged as a cold isolate",
  );
  const counted = broken((i) => {
    i.confirmStartup = startupReading([...plainWarm, ...firstThree, { handlerMs: 900, beforeMs: 4_000, cold: true, index: 0 }]);
  });
  assert(bars(counted).includes("confirm startup"), "control: the same confirm counted as its isolate's first request fails the bar");
  // A first request the stamp reads warm is still the request that started its isolate,
  // so it is IN the population and its wait is judged: no separate finding about it.
  const stampWarm = broken((i) => {
    i.confirmStartup = startupReading([...plainWarm, ...firstThree, { handlerMs: 900, beforeMs: 4_000, cold: true, stampCold: false }]);
  });
  const stampWarmDetail = stampWarm.findings.find((f) => f.bar === "confirm startup")?.detail ?? "";
  assert(/p95 4000ms/.test(stampWarmDetail), `a first request the stamp reads warm is judged with the cold ones (got: ${stampWarmDetail})`);
  eq(stampWarm.findings.filter((f) => f.bar === "confirm startup").length, 1, "and is one finding, about its wait");

  // #3418: a confirm with no invocation index is on neither side, so the cold population
  // may be missing a first request among them; a pass then could be a smaller population
  // rather than a faster one (L457), and it is said by name.
  const someUnknown = broken((i) => {
    i.confirmStartup = startupReading([...plainWarm, ...firstThree, { handlerMs: 900, beforeMs: 600, cold: false, index: null }]);
  });
  const unknownDetail = someUnknown.findings.find((f) => f.bar === "confirm startup")?.detail ?? "";
  assert(
    /1 of 44 confirms carried no invocation index/.test(unknownDetail),
    `a confirm with no invocation index is named as a gap in the cold population (got: ${unknownDetail})`,
  );
  assert(!bars(broken(() => {})).includes("confirm startup"), "control: with every index read there is no such finding");

  // The other direction, and the one that matters: a confirm that is itself slow
  // must NOT be reported as a startup problem. Same total wall time, other half.
  const fatConfirm = broken((i) => {
    // Cold starts still present and healthy, so only the confirm's own cost moved.
    i.confirmStartup = startupReading([
      ...Array.from({ length: 40 }, () => ({ handlerMs: 4_000, beforeMs: 500, cold: false })),
      ...Array.from({ length: 3 }, () => ({ handlerMs: 4_000, beforeMs: 1_200, cold: true })),
    ]);
  });
  assert(
    !bars(fatConfirm).includes("confirm startup"),
    "an expensive confirm on a warm isolate is not a startup finding, which is the whole " +
      "point of splitting them",
  );
  eq(fatConfirm.measurements!.confirmHandler!.p95, 4_000, "and its own cost is still reported");
}

// --- a split nobody could read is never a pass (L98) ---------------------------------
{
  const unread = broken((i) => {
    i.confirmStartup = null;
  });
  assert(
    bars(unread).includes("confirm startup"),
    "an archive carrying no confirm profile fails its bar rather than passing it, exactly as a " +
      "ceiling control that never ran does",
  );
  const detail = unread.findings.find((f) => f.bar === "confirm startup")!.detail;
  assert(
    /archive|tail\.jsonl/.test(detail),
    "and the detail names the artifact, because that is what a reader has to fix",
  );
  assert(
    !/cold isolate waited/.test(detail),
    "and it does not borrow the other message's words for a number it never measured (L11)",
  );
  eq(unread.measurements!.confirmSamples, null, "the measurement is null, never a zero");
  eq(unread.measurements!.confirmHandler, null, "and so is every percentile over it");
}

// --- an archive that arrived and said nothing is not a pass either (L98) --------------
{
  // Distinct from a missing file, and distinct from a slow start: three states, one
  // bar, three sentences, because they send a reader to three different places (L11).
  const empty = broken((i) => {
    // A truncated stream: the archive is written under a `wrangler tail` timeout, so
    // its last line is routinely half written.
    i.confirmStartup = readConfirmStartup('{"eventTimestamp": 0, "logs": [{"mess');
  });
  assert(
    bars(empty).includes("confirm startup"),
    "an archive holding no readable confirm profile fails its bar",
  );
  const emptyDetail = empty.findings.find((f) => f.bar === "confirm startup")!.detail;
  assert(/not readable JSON/.test(emptyDetail), "and says what it actually met");

  const noCold = broken((i) => {
    i.confirmStartup = startupReading(
      Array.from({ length: 40 }, () => ({ handlerMs: 900, beforeMs: 500, cold: false })),
    );
  });
  assert(
    bars(noCold).includes("confirm startup"),
    "and so does a reading in which nothing was ever the first on its isolate, since that is " +
      "the shape of a reading that broke rather than of a lucky run",
  );
  // #3418: no first request, while the stamp shows confirms that loaded the confirm's code
  // on an isolate already running. Still nothing measured (L98), but isolates DID start,
  // so the sentence must not call the reading broken; it names what was seen instead.
  const noFirstButStamp = broken((i) => {
    i.confirmStartup = startupReading([
      ...Array.from({ length: 40 }, () => ({ handlerMs: 900, beforeMs: 500, cold: false })),
      ...Array.from({ length: 2 }, () => ({ handlerMs: 900, beforeMs: 900, cold: false, stampCold: true, index: 1 })),
    ]);
  });
  const noFirstDetail = noFirstButStamp.findings.find((f) => f.bar === "confirm startup")?.detail ?? "";
  assert(/2 were the first confirm on an isolate that had already run the app/.test(noFirstDetail), `a run whose isolates started on other requests says so (got: ${noFirstDetail})`);
  assert(!/broke/.test(noFirstDetail), `and does not call that reading broken (got: ${noFirstDetail})`);
  // #3418: an archive whose confirms carry no invocation index at all cannot say which
  // were first, which is its own state: an older deployment, not a run with no cold start.
  const noIndex = broken((i) => {
    i.confirmStartup = startupReading(
      Array.from({ length: 40 }, (_, n) => ({ handlerMs: 900, beforeMs: 500, cold: n < 3, index: null })),
    );
  });
  const noIndexDetail = noIndex.findings.find((f) => f.bar === "confirm startup")?.detail ?? "";
  assert(/none of the 40 confirms read carried the Worker's invocation index/.test(noIndexDetail), `a reading with no index anywhere says so (got: ${noIndexDetail})`);
  eq(noIndex.findings.filter((f) => f.bar === "confirm startup").length, 1, "as one finding, not also as some confirms lacking it");
  // A state with no finding at all collapses to one shared placeholder, so it fails the
  // count below rather than throwing and hiding every block after this one.
  const distinct = new Set(
    [empty, noCold, noFirstButStamp, noIndex, broken((i) => { i.confirmStartup = null; })].map(
      (r) => r.findings.find((f) => f.bar === "confirm startup")?.detail ?? "(no finding)",
    ),
  );
  eq(distinct.size, 5, "and no two of the five share a sentence");
}

// --- #3418: run 37520312761's startup bar, under each definition ---------------------
{
  // The pre-profile waits of the 8 confirms that run's report called "the first on their
  // isolate" (the module stamp), read from its archived tail (artifact 11443066359), with
  // the Worker's own count for each, beside ordinary warm confirms at its warm median.
  // `scripts/test-confirm-startup.ts` holds the same 8 at full detail.
  const real = [
    { beforeMs: 2_483, index: 1 },
    { beforeMs: 1_107, index: 1 },
    { beforeMs: 859, index: 2 },
    { beforeMs: 1_121, index: 0 },
    { beforeMs: 1_482, index: 0 },
    { beforeMs: 1_502, index: 0 },
    { beforeMs: 2_801, index: 0 },
    { beforeMs: 1_078, index: 1 },
  ];
  // Every one of the 8 has a module younger than its wait, which is what made the stamp call it cold.
  const rows = [
    ...real.map((c) => ({ handlerMs: 3_500, beforeMs: c.beforeMs, cold: c.index === 0, stampCold: true, index: c.index })),
    ...Array.from({ length: 40 }, () => ({ handlerMs: 3_700, beforeMs: 1_664, cold: false })),
  ];
  const cs = startupReading(rows)!;
  const old = percentiles(real.map((c) => c.beforeMs))!;
  const corrected = percentiles(real.filter((c) => c.index === 0).map((c) => c.beforeMs))!;
  eq(`${old.p95} ${corrected.p95}`, "2801 2801", "the old cold p95 over 8 and the corrected one over 4 are both the slowest first request");
  eq(cs.cold, 4, "the reading's cold population is the Worker's 4");
  eq(percentiles(cs.coldPreProfileMs)!.p95, corrected.p95, "and the bar judges the corrected figure");
  const verdict = broken((i) => {
    i.confirmStartup = cs;
  });
  const detail = verdict.findings.find((f) => f.bar === "confirm startup")?.detail ?? "";
  assert(/p95 2801ms/.test(detail) && /over the 2500ms/.test(detail), `the bar still fails at 2801ms against 2500ms (got: ${detail})`);
  assert(/4 of 48 confirms here were their isolate's first request/.test(detail), `and names the 4, not the stamp's 8 (got: ${detail})`);
  assert(!/\b8 of 48\b/.test(detail), `the stamp's count is not printed as the bar's population (got: ${detail})`);

  // The report's wall time line states ONE count of first requests, and names the 4 the
  // stamp alone called cold as what they were rather than as a second count (#3418).
  const wall = confirmWallText(verdict.measurements!, cs);
  assert(/over 48 confirms \(4 of them their isolate's first request/.test(wall), `the wall time line says 4 (got: ${wall})`);
  assert(/4 more loaded the confirm's code on an isolate that had already run the app and are counted warm/.test(wall), `and names the 4 the stamp alone called cold (got: ${wall})`);
  assert(!/first on their isolate/.test(wall), `with no second phrasing of the same count (got: ${wall})`);
  assert(wall.includes(`cold p95 ${corrected.p95}ms`), `and the cold p95 it prints is the bar's (got: ${wall})`);
}

// --- #3418: the wall time line names every way the two counts can differ ---------------
{
  const cs = startupReading([
    ...Array.from({ length: 10 }, () => ({ handlerMs: 900, beforeMs: 500, cold: false })),
    { handlerMs: 900, beforeMs: 1_400, cold: true, stampCold: false },
    { handlerMs: 900, beforeMs: 600, cold: false, index: null },
  ])!;
  const r = broken((i) => {
    i.confirmStartup = cs;
  });
  const wall = confirmWallText(r.measurements!, cs);
  assert(/over 12 confirms \(1 of them their isolate's first request/.test(wall), `one count of first requests (got: ${wall})`);
  assert(/1 carried no invocation index and is on neither side/.test(wall), `a confirm with no index is named (got: ${wall})`);
  assert(/1 of those first requests found the confirm's code already loaded/.test(wall), `a first request the stamp read warm is named (got: ${wall})`);
  assert(!/more loaded the confirm's code/.test(wall), `and a difference that did not occur is not mentioned (got: ${wall})`);
  const agreeing = startupReading([
    ...Array.from({ length: 10 }, () => ({ handlerMs: 900, beforeMs: 500, cold: false })),
    { handlerMs: 900, beforeMs: 1_400, cold: true },
  ])!;
  const plain = confirmWallText(broken((i) => { i.confirmStartup = agreeing; }).measurements!, agreeing);
  assert(/over 11 confirms \(1 of them their isolate's first request\): inside/.test(plain), `with nothing to name, the count stands alone (got: ${plain})`);
  const none = broken((i) => {
    i.confirmStartup = null;
  });
  assert(/carried no confirm profile/.test(confirmWallText(none.measurements!, null)), "and a run with no archive says so");
}

// --- the CPU finding says which half moved -------------------------------------------
{
  // The reading that would otherwise send somebody to optimise the confirm while
  // the seconds are being spent before it starts.
  const cpu = broken((i) => {
    i.platform = { ...i.platform, cpuMsP99: 2_988 };
  });
  const cpuDetail = cpu.findings.find((f) => f.bar === "Worker CPU on the request path")!.detail;
  assert(/their isolate.s first request/.test(cpuDetail), "the CPU finding names how many were cold starts");
  assert(/inside it/.test(cpuDetail), "and the confirm's own share beside it");
  assert(
    /AFTER the response had gone/.test(cpuDetail),
    "and the span the 2026-09-14 archive says the time is actually in, which this percentile " +
      "counts and no lead waits for",
  );

  const blind = broken((i) => {
    i.platform = { ...i.platform, cpuMsP99: 2_988 };
    i.confirmStartup = null;
  });
  const blindDetail = blind.findings.find(
    (f) => f.bar === "Worker CPU on the request path",
  )!.detail;
  assert(
    /could not be read/.test(blindDetail),
    "and where the split is unavailable it SAYS so rather than quietly claiming the whole " +
      "number is the confirm's",
  );
}

// --- the per address ceiling, proved by its own step ---------------------------------

{
  const never = broken((i) => {
    i.ipCeilingControl = ceilingVerdict(
      Array(CEILING_EXACT_BOUND + 20).fill({
        status: 200,
        seenIp: "203.0.113.9",
        refusedBy: null,
      }) as CeilingAttempt[],
      60,
      CEILING_EXACT_BOUND,
    );
  });
  assert(
    bars(never).includes("the per address write ceiling"),
    "writes from one address PAST the exact hourly cap with none refused means the per address " +
      "protection is not applying, so every 429 the run attributed means something else",
  );

  const notRun = broken((i) => {
    i.ipCeilingControl = ceilingVerdict([], 60, CEILING_EXACT_BOUND);
  });
  const notRunDetail = notRun.findings.find((f) => f.bar === "the per address write ceiling")!.detail;
  assert(
    notRunDetail.includes("no writes at all"),
    "a control that never ran says SO, rather than claiming the ceiling is not applying: one sends " +
      "somebody to the limiter and the other to a job that produced no file (L11)",
  );
  assert(
    !notRunDetail.includes("none was refused"),
    "and does not borrow the other message's words",
  );

  const early = broken((i) => {
    i.ipCeilingControl = ceilingVerdict(
      [
        ...Array(11).fill({ status: 200, seenIp: "203.0.113.9", refusedBy: null }),
        ...Array(169).fill({
          status: 429,
          seenIp: "203.0.113.9",
          refusedBy: CEILING_REFUSED_BY.address,
        }),
      ] as CeilingAttempt[],
      60,
      CEILING_EXACT_BOUND,
    );
  });
  assert(
    bars(early).includes("the per address write ceiling"),
    "and refusing EARLY is a finding too, since the run's own pacing sits on that number",
  );
}

// --- the platform's own numbers ------------------------------------------------------

{
  const lagging = broken((i) => {
    // The control. The pipeline has lagged three hours (#1533), and a low reading
    // from a lagging pipeline looks exactly like a cheap run.
    i.platform.invocations = 3;
  });
  eq(lagging.verdict, "unmeasured", "an invocation count far under the run's own is UNMEASURED");
  eq(lagging.exit, JUDGE_EXIT.unmeasured, "on its own exit code");
  assert(
    lagging.measurements !== null,
    "and everything the run itself measured is still reported, since only the platform half is blind",
  );

  const absent = broken((i) => {
    i.platform.cpuMsP99 = null;
  });
  eq(absent.verdict, "unmeasured", "a missing CPU reading is unmeasured rather than a pass");

  const hot = broken((i) => {
    i.platform.cpuMsP99 = REQUEST_CPU_P99_MS + 1;
  });
  assert(
    bars(hot).includes("Worker CPU on the request path"),
    "CPU over the REQUEST budget is a finding, and the bar says which path it is about (#2321)",
  );

  // SUBREQUESTS are deliberately not a bar: Cloudflare exposes no counter for them,
  // so one would leave this judge permanently unable to conclude, which is the
  // shape #2240's first cal.com probe shipped in. The BREACH is measurable and is
  // what is judged, through the outcome histogram.
  const killed = broken((i) => {
    i.platform.statuses = { success: 600, exceededCpu: 10 };
  });
  assert(bars(killed).includes("platform outcome"), "an invocation the platform cut off is a finding");
  assert(
    killed.findings.find((f) => f.bar === "platform outcome")!.detail.includes("exceededCpu"),
    "named by WHICH outcome, since a CPU kill and a subrequest breach are different things to fix",
  );

  const breached = broken((i) => {
    i.platform.statuses = { success: 609, scriptThrewException: 1 };
  });
  assert(bars(breached).includes("platform outcome"), "and so is any other non-ok outcome");

  const noOutcomes = broken((i) => {
    i.platform.statuses = {};
  });
  eq(
    noOutcomes.verdict,
    "unmeasured",
    "an EMPTY histogram is a reading that found nothing, never every invocation being fine",
  );

  const nullOutcomes = broken((i) => {
    i.platform.statuses = null;
  });
  eq(nullOutcomes.verdict, "unmeasured", "and an absent one is unmeasured too");
}

// --- the fault pass ---------------------------------------------------------------------

{
  const errored = broken((i) => {
    i.faultPass = { attempts: 100, availabilityUnread: 0, fiveXx: 4, faultPct: 10, faultTargets: ["google-read"] };
  });
  assert(
    bars(errored).includes("the fault pass"),
    "a 5xx while Google is failing ten percent of reads: the path must degrade, not error",
  );

  const empty = broken((i) => {
    i.faultPass = { attempts: 0, availabilityUnread: 0, fiveXx: 0, faultPct: 10, faultTargets: ["google-read"] };
  });
  assert(
    bars(empty).includes("the fault pass"),
    "and a fault pass that made no requests proves nothing, so zero 5xx is not a pass (L98)",
  );

  const none = broken((i) => {
    delete i.faultPass;
  });
  assert(!bars(none).includes("the fault pass"), "a run with no fault pass is judged on the rest");

  // #3348: the fault drivers run the steady drivers' loop, so a request whose bucket's
  // times could not be read is counted as an attempt without ever being sent. A pass
  // that sent nothing proved nothing, however many attempts it counted (L98).
  const allUnread = broken((i) => {
    i.faultPass = { attempts: 100, availabilityUnread: 100, fiveXx: 0, faultPct: 10, faultTargets: ["google-read"] };
  });
  assert(
    bars(allUnread).includes("the fault pass"),
    `a fault pass whose every request went unsent made no requests (got ${JSON.stringify(bars(allUnread))})`,
  );
  // With only systems the path degrades around failing, the availability read must still
  // answer, so one unsent request is a finding, on its own bar, as it is in steady load.
  const someUnread = broken((i) => {
    i.faultPass = { attempts: 100, availabilityUnread: 3, fiveXx: 0, faultPct: 10, faultTargets: ["google-read"] };
  });
  assert(
    bars(someUnread).includes("fault pass requests never sent"),
    `an unsent request while Google reads are failing is a finding (got ${JSON.stringify(bars(someUnread))})`,
  );
  const said = someUnread.findings.find((f) => f.bar === "fault pass requests never sent")?.detail ?? "";
  assert(/3 requests were never sent/.test(said), `naming how many (got ${said})`);
  // Control (L159): the same pass with every request sent trips neither bar.
  const allSent = broken((i) => {
    i.faultPass = { attempts: 100, availabilityUnread: 0, fiveXx: 0, faultPct: 10, faultTargets: ["google-read"] };
  });
  assert(
    !bars(allSent).includes("the fault pass") && !bars(allSent).includes("fault pass requests never sent"),
    `control: a fault pass that sent every request trips neither (got ${JSON.stringify(bars(allSent))})`,
  );
}

// --- what the fault drivers' files are counted as (#3348) --------------------------------

{
  // The counts run-judge hands the judge, from the fault drivers' own attempts. An unsent
  // attempt has no status, so it is neither a 5xx nor, once subtracted, a request sent.
  const like = passing().driverResults[0]!.attempts[0]!;
  const at = (status: number, outcome: typeof like.outcome) => ({ ...like, status, outcome });
  const counts = faultPassCounts([
    at(201, like.outcome),
    at(0, AVAILABILITY_UNREAD),
    at(503, like.outcome),
    at(0, AVAILABILITY_UNREAD),
    at(500, like.outcome),
  ]);
  eq(counts, { attempts: 5, availabilityUnread: 2, fiveXx: 2 }, "unsent attempts and 5xx are counted from the attempts' own outcome and status");

  // The report line says how many were sent, and how many were not when any were not.
  const loud = faultPassReportLine({ ...counts, faultPct: 10, faultTargets: ["supabase"] });
  assert(
    /3 requests sent/.test(loud) && /2 never sent because their bucket's times could not be read/.test(loud) && /2 5xx/.test(loud),
    `the fault pass line names sent, unsent and 5xx (got ${loud})`,
  );
  assert(/reported, not barred/.test(loud), `and says a database fault's 5xx are not barred (got ${loud})`);
  const clean = faultPassReportLine({ attempts: 4, availabilityUnread: 0, fiveXx: 0, faultPct: 10, faultTargets: ["google-read"] });
  assert(/4 requests sent/.test(clean) && !/never sent/.test(clean) && /held to no 5xx/.test(clean), `a pass that sent everything says so plainly (got ${clean})`);
}

// --- which systems failed decides the bar (#3104) ----------------------------------------

{
  // A database fault or a failing calendar write is a 5xx BY DESIGN, so with one in the
  // mix the 5xx count measures the percentage, not the code. It is not barred.
  for (const loud of [["google-read", "supabase"], ["google-write"]]) {
    const r = broken((i) => {
      i.faultPass = { attempts: 100, availabilityUnread: 0, fiveXx: 7, faultPct: 10, faultTargets: loud };
      i.expectedLegs = { ...i.expectedLegs, faultTargets: loud };
    });
    assert(!bars(r).includes("the fault pass"), `5xx with ${loud.join(", ")} failing is not barred`);
    // #3348: the availability read meets the same designed failure, so an unsent
    // request is reported beside the 5xx count rather than barred...
    const someUnread = broken((i) => {
      i.faultPass = { attempts: 100, availabilityUnread: 3, fiveXx: 7, faultPct: 10, faultTargets: loud };
      i.expectedLegs = { ...i.expectedLegs, faultTargets: loud };
    });
    assert(
      !bars(someUnread).includes("fault pass requests never sent") && !bars(someUnread).includes("the fault pass"),
      `an unsent request with ${loud.join(", ")} failing is not barred (got ${JSON.stringify(bars(someUnread))})`,
    );
    // ...but a pass that sent nothing still proved nothing, whatever failed (L98).
    const allUnread = broken((i) => {
      i.faultPass = { attempts: 100, availabilityUnread: 100, fiveXx: 0, faultPct: 10, faultTargets: loud };
      i.expectedLegs = { ...i.expectedLegs, faultTargets: loud };
    });
    assert(bars(allUnread).includes("the fault pass"), `a pass with ${loud.join(", ")} failing that sent nothing is refused`);
  }
  // Control (L159): the same count with only degrading systems failing IS a finding.
  for (const soft of [["google-read", "webhook", "salesforce"]]) {
    const r = broken((i) => {
      i.faultPass = { attempts: 100, availabilityUnread: 0, fiveXx: 7, faultPct: 10, faultTargets: soft };
      i.expectedLegs = { ...i.expectedLegs, faultTargets: soft };
    });
    assert(bars(r).includes("the fault pass"), `5xx with ${soft.join(", ")} failing is still a finding`);
  }
}
{
  const i = passing();
  i.faultPass = { attempts: 100, availabilityUnread: 0, fiveXx: 0, faultPct: 10, faultTargets: ["google-read"] };
  i.expectedLegs = { ...i.expectedLegs, faultTargets: ["google-read", "supabase"] };
  assert(
    incompleteness(i).some((w) => w.includes("not the google-read, supabase it was configured for")),
    "a pass whose deployment failed different systems from the ones asked for is incomplete",
  );
  const j = passing();
  j.faultPass = { attempts: 100, availabilityUnread: 0, fiveXx: 0, faultPct: 10, faultTargets: [] };
  assert(
    incompleteness(j).some((w) => w.includes("did not record which systems")),
    "and so is one whose driver never recorded them",
  );
  const k = passing();
  k.expectedLegs = { ...k.expectedLegs, faultTargets: undefined };
  eq(incompleteness(k), [], "an unstated expectation is the default list, so an existing run is unchanged");
}

// --- the cron lanes under fault, scored (#3104) -------------------------------------------

{
  const missing = passing();
  missing.faultLanes = { evidence: null, expectations: fixtureLaneExpectations(LANES_T0) };
  assert(
    incompleteness(missing).some((w) => w.includes("no lane sampler file arrived")),
    "a fault pass with no lane evidence is incomplete, never a pass",
  );
  const absent = passing();
  delete absent.faultLanes;
  assert(incompleteness(absent).some((w) => w.includes("no lane sampler file")), "nor when the field is absent");

  // The judge could not establish which lanes the deployment runs (the setting was
  // missing or named no lane): incomplete, with that reason, and nothing thrown.
  const unknownLanes = passing();
  unknownLanes.faultLanes = {
    evidence: healthyFaultLanes(LANES_T0, RUN),
    expectations: { why: "EXPECT_LANES_DISABLED is unset or empty" },
  };
  assert(
    incompleteness(unknownLanes).includes("EXPECT_LANES_DISABLED is unset or empty"),
    "lanes the judge cannot establish make the run incomplete",
  );
  const unknownVerdict = judgeBookingRun(unknownLanes);
  eq(unknownVerdict.verdict, "incomplete", "a verdict, not a crash");
  eq(unknownVerdict.exit, JUDGE_EXIT.incomplete, "on the incomplete exit code");

  const holed = passing();
  const ev = healthyFaultLanes(LANES_T0, RUN);
  ev.samples = ev.samples.filter((s) => s.atMs < LANES_T0 + 60_000 || s.atMs > LANES_T0 + 4 * 60_000);
  holed.faultLanes = { evidence: ev, expectations: fixtureLaneExpectations(LANES_T0) };
  assert(incompleteness(holed).some((w) => w.includes("hole")), "and so is a lane series with a hole in it");

  const silent = broken((i) => {
    const e = healthyFaultLanes(LANES_T0, RUN);
    for (const s of e.samples) delete s.alerts[SYNC_FAILURE_ALERT_KEY];
    i.faultLanes = { evidence: e, expectations: fixtureLaneExpectations(LANES_T0) };
  });
  assert(bars(silent).includes("the calendar failure page under fault"), "no page under fault fails the run");

  const stalled = broken((i) => {
    const e = healthyFaultLanes(LANES_T0, RUN);
    for (const s of e.samples) s.heartbeats.outbox = new Date(LANES_T0 - 20 * 60_000).toISOString();
    i.faultLanes = { evidence: e, expectations: fixtureLaneExpectations(LANES_T0) };
  });
  assert(bars(stalled).includes("lane heartbeats under fault"), "a lane gone stale under fault fails the run");
}

// --- the small pure pieces ---------------------------------------------------------------

{
  eq(percentiles([]), null, "no values gives null, never a zero p95 that reads as instant");
  const p = percentiles([1, 2, 3, 4, 100])!;
  eq(p.max, 100, "the max is the max");
  assert(p.p95 >= p.p50, "and the p95 is at or above the p50");

  const win = (s: string, e: string): JudgedBooking => ({
    id: "x",
    external_id: "x",
    idempotency_key: "k",
    assigned_user_id: "a",
    starts_at: s,
    ends_at: e,
    status: "confirmed",
  });
  assert(
    !overlaps(win("2026-09-15T10:00:00Z", "2026-09-15T10:20:00Z"), win("2026-09-15T10:20:00Z", "2026-09-15T10:40:00Z")),
    "back to back calls do not overlap, because the window is half open",
  );
  assert(
    overlaps(win("2026-09-15T10:00:00Z", "2026-09-15T10:20:00Z"), win("2026-09-15T10:10:00Z", "2026-09-15T10:30:00Z")),
    "and a genuine clash does",
  );
  assert(
    overlaps(win("not a date", "2026-09-15T10:20:00Z"), win("2026-09-15T10:30:00Z", "2026-09-15T10:50:00Z")),
    "an unreadable bound reads as OVERLAPPING, never as clear: this is the one comparison whose " +
      "permissive answer would hide a double booking",
  );
}

{
  // `incompleteness` is reachable on its own, so a caller can report why without
  // judging, and a complete run really does produce nothing.
  eq(incompleteness(passing()).length, 0, "a complete run has nothing to report as incomplete");
}

// --- a leg that was CONFIGURED and never arrived (#2262) ----------------------
//
// The bars for the burst and the fault pass are skipped when their results are
// absent, which is right for a hand run that drove neither. What that could not
// tell apart was a leg the workflow really ran whose artifact never got here: the
// judge read it as "this run had no burst leg" and published a report with its
// most important control quietly missing (L98, L11).

{
  // The quiet direction first: a run that asked for neither leg is still complete
  // without them, which is what a hand run does.
  const i = passing();
  i.burstResults = [];
  i.faultPass = undefined;
  i.expectedLegs = { burstDrivers: 0, faultPct: 0 };
  eq(incompleteness(i).length, 0, "a run configured with neither leg is complete without them");
}

// A configured burst leg that did not arrive whole FAILS the burst with its reason
// (#3222), rather than making the whole run unjudgeable or reading as absent.

{
  const i = passing();
  const want = i.burstResults.length;
  i.burstResults = i.burstResults.slice(0, want - 1);
  const why = burstShortfall(i);
  assert(
    why.some((r) => r.includes("burst driver files")),
    "a burst leg missing a driver file is a burst shortfall",
  );
  assert(
    why.some((r) => r.includes(String(want))),
    "and the reason says how many were expected",
  );
  const r = judgeBookingRun(i);
  eq(r.verdict, "fail", "which fails the run");
  eq(incompleteness(i), [], "rather than making it incomplete");
}

{
  const i = passing();
  i.burstResults = [];
  const r = judgeBookingRun(i);
  assert(
    r.findings.some((f) => f.bar === "the burst" && f.detail.includes("burst driver files")),
    "a burst leg that produced NOTHING fails rather than being treated as absent",
  );
}

{
  // A burst driver that fired fewer requests than it planned is a smaller burst
  // than the one being judged, and "exactly one 200" is satisfiable by a burst of
  // one.
  const i = passing();
  i.burstResults[0]!.attempts = i.burstResults[0]!.attempts.slice(0, 1);
  assert(
    burstShortfall(i).some((r) => r.includes("of") && r.includes("planned requests")),
    "a burst driver that fired a fraction of its plan is a burst shortfall",
  );
  eq(judgeBookingRun(i).verdict, "fail", "and fails the run");
}

{
  const i = passing();
  i.burstResults[0]!.runId = "some-other-run";
  assert(
    incompleteness(i).some((r) => r.includes("not " + RUN)),
    "a burst file from another run is incomplete",
  );
}

{
  const i = passing();
  i.faultPass = undefined;
  const why = incompleteness(i);
  assert(
    why.some((r) => r.includes("fault pass") && r.includes("never asked")),
    "a fault leg that was configured and never arrived is incomplete",
  );
}

{
  // The case the whole fault leg rests on. A deployment running zero percent
  // answers every request perfectly, so `fiveXx: 0` would PASS the bar having
  // injected nothing at all.
  const i = passing();
  i.faultPass = { attempts: 120, availabilityUnread: 0, fiveXx: 0, faultPct: 0, faultTargets: ["google-read"] };
  const why = incompleteness(i);
  assert(
    why.some((r) => r.includes("reporting 0 percent")),
    "a fault pass against a deployment at zero percent is incomplete, not a pass",
  );
  // The other direction (L159): the same pass at the configured percentage is
  // complete, so this is about the percentage rather than about the shape.
  const ok = passing();
  ok.faultPass = { attempts: 120, availabilityUnread: 0, fiveXx: 0, faultPct: 10, faultTargets: ["google-read"] };
  eq(incompleteness(ok).length, 0, "and the same pass at ten percent is complete");
}

{
  // A run that asked for no fault leg is not judged on one it happens to carry:
  // the expectation is what decides, so a hand run that drove a fault pass out of
  // curiosity still judges its bar without being called incomplete for the
  // percentage it chose.
  const i = passing();
  i.expectedLegs = { burstDrivers: i.burstResults.length, faultPct: 0 };
  i.faultPass = { attempts: 50, availabilityUnread: 0, fiveXx: 0, faultPct: 25, faultTargets: ["google-read"] };
  eq(incompleteness(i).length, 0, "an unasked-for fault pass does not make a run incomplete");
}

// --- what the first real run found (#2261) ------------------------------------

{
  // The platform half could not be read AND two other bars had already failed.
  // Returning only the platform finding discarded them: the live run held a burst
  // with two winners and a fault pass answering three 500s, both measured, both
  // real, and the report said nothing but "the analytics API did not report".
  const r = broken((i) => {
    i.platform = { invocations: null, cpuMsP99: null, subrequests: null, statuses: null, cron: null };
    i.faultPass = { attempts: 30, availabilityUnread: 0, fiveXx: 3, faultPct: 10, faultTargets: ["google-read"] };
  });
  assert(
    r.findings.some((f) => f.bar === "the fault pass"),
    "a measured failure survives an unreadable platform half",
  );
  assert(
    r.findings.some((f) => f.bar === "platform limits"),
    "and the platform finding is reported beside it",
  );
  // And the VERDICT is a failure, not "could not conclude": a measured failure is
  // a failure whatever the analytics did, and filing it under unmeasured is how a
  // finding stops being read.
  eq(r.verdict, "fail", "the run is judged failed rather than unmeasured");
  eq(r.exit, JUDGE_EXIT.fail, "on the failure exit code");
}

{
  // The other direction (L159): when the platform half really is the ONLY thing
  // with anything to say, `unmeasured` is still the verdict.
  const r = broken((i) => {
    i.platform = { invocations: null, cpuMsP99: null, subrequests: null, statuses: null, cron: null };
  });
  eq(r.verdict, "unmeasured", "a clean run with an unreadable platform half is unmeasured");
  eq(r.findings.length, 1, "carrying the one finding it has");
  eq(r.findings[0]!.bar, "platform limits", "which is the platform one");
}

{
  // The same, for the invocation CONTROL: a lagging pipeline must not erase a
  // measured failure either.
  const r = broken((i) => {
    i.platform = { invocations: 1, cpuMsP99: 10, subrequests: 8, statuses: { success: 1 }, cron: { invocations: 0, worstCpuMs: 0, byCron: {} }, cronSource: "agreed-empty" };
    i.faultPass = { attempts: 30, availabilityUnread: 0, fiveXx: 3, faultPct: 10, faultTargets: ["google-read"] };
  });
  assert(
    r.findings.some((f) => f.bar === "the fault pass"),
    "a measured failure survives a lagging invocation count too",
  );
  eq(r.verdict, "fail", "and that run is failed rather than unmeasured");
}

// --- the burst is judged per AGENT, not at exactly one winner -----------------

{
  // The live case. TWO winners at one slot, on two DIFFERENT agents, which is
  // `bookings_active_slot_uniq` working exactly as specified: the burst code's
  // pool was two agents deep, which the seed does not guarantee to be one. A bar
  // failing on that is red for a property of the roster.
  const r = broken((i) => {
    const second = { ...i.burstResults[0]!.attempts[1]!, status: 200, outcome: "created" };
    i.burstResults[0]!.attempts[1] = second;
    i.bookings = [
      ...i.bookings,
      bookingFor(second, { assigned_user_id: "agent-a-different-one" }),
    ];
  });
  assert(
    !r.findings.some((f) => f.bar.startsWith("the burst")),
    "two winners on two different agents is not a finding",
  );
}

{
  // And the thing the control exists for still fails: two winners resolving to ONE
  // agent is an agent holding two active bookings at one slot.
  const r = broken((i) => {
    const second = { ...i.burstResults[0]!.attempts[1]!, status: 200, outcome: "created" };
    i.burstResults[0]!.attempts[1] = second;
    i.bookings = [...i.bookings, bookingFor(second, { assigned_user_id: "agent-beyond" })];
  });
  assert(
    r.findings.some((f) => f.bar === "the burst's winners" && f.detail.includes("two active bookings")),
    "two winners on ONE agent is caught",
  );
}

{
  // A burst where nobody won proves nothing about contention: the slot was already
  // taken before it fired. Said in its own words rather than passing quietly.
  const r = broken((i) => {
    for (const b of i.burstResults) {
      b.attempts = b.attempts.map((a) => ({ ...a, status: 409, outcome: "SLOT_TAKEN" }));
    }
  });
  assert(
    r.findings.some((f) => f.bar === "the burst" && f.detail.includes("already")),
    "a burst nobody won is a finding",
  );
  assert(
    r.findings.some((f) => f.bar === "the burst" && f.detail.includes("409 SLOT_TAKEN")),
    "and it names the refusals it read, by code",
  );
}

{
  // But "already taken" is a claim about the refusals, so it may be made only when the
  // refusals SAY it. Run 37333201026 had an untouched slot and every burst request
  // refused 503 VERIFY_UNAVAILABLE, and the judge still told the reader the slot had
  // been taken before the burst fired (L11). It must say what the refusals were.
  const r = broken((i) => {
    for (const b of i.burstResults) {
      b.attempts = b.attempts.map((a) => ({ ...a, status: 503, outcome: "VERIFY_UNAVAILABLE" }));
    }
  });
  const burst = r.findings.find((f) => f.bar === "the burst");
  assert(burst !== undefined, "a burst refused entirely with 503s is a finding");
  assert(
    burst !== undefined && !burst.detail.includes("already taken"),
    `and it does not claim the slot was already taken (got: ${burst?.detail})`,
  );
  const total = passing().burstResults.reduce((n, b) => n + b.attempts.length, 0);
  assert(
    burst !== undefined && burst.detail.includes(`${total} 503 VERIFY_UNAVAILABLE`),
    `it names the refusals by code and count (got: ${burst?.detail})`,
  );
}

{
  // A refusal that carried no outcome at all is labelled as such, never rendered as
  // "undefined", and is never counted as SLOT_TAKEN.
  const r = broken((i) => {
    for (const b of i.burstResults) {
      b.attempts = b.attempts.map((a) => ({ ...a, status: 503, outcome: undefined as unknown as string }));
    }
  });
  const burst = r.findings.find((f) => f.bar === "the burst");
  assert(
    burst !== undefined && !burst.detail.includes("undefined"),
    `a refusal with no outcome never renders as undefined (got: ${burst?.detail})`,
  );
  assert(
    burst !== undefined && burst.detail.includes("503 no outcome"),
    `it is labelled as having no outcome (got: ${burst?.detail})`,
  );
  assert(
    burst !== undefined && !burst.detail.includes("already taken"),
    "and it is not counted as the slot being taken",
  );
}

{
  // The losers finding labels refusals with the SAME helper, so a loser with no
  // outcome reads "no outcome" there too, never "undefined".
  const r = broken((i) => {
    const a = i.burstResults[0]!.attempts[1]!;
    i.burstResults[0]!.attempts[1] = { ...a, status: 503, outcome: undefined as unknown as string };
  });
  const losers = r.findings.find((f) => f.bar === "the burst's losers");
  assert(losers !== undefined, "a loser refused with no outcome is a losers finding");
  assert(
    losers !== undefined && !losers.detail.includes("undefined") && losers.detail.includes("503 no outcome"),
    `and it is labelled as having no outcome (got: ${losers?.detail})`,
  );
}

{
  // A mixed refusal set is not "already taken" either: some of it was something else.
  const r = broken((i) => {
    for (const b of i.burstResults) {
      b.attempts = b.attempts.map((a, n) =>
        n === 0 ? { ...a, status: 503, outcome: "VERIFY_UNAVAILABLE" } : { ...a, status: 409, outcome: "SLOT_TAKEN" },
      );
    }
  });
  const burst = r.findings.find((f) => f.bar === "the burst");
  assert(
    burst !== undefined && !burst.detail.includes("already taken"),
    `a burst whose refusals were not all SLOT_TAKEN does not claim the slot was taken (got: ${burst?.detail})`,
  );
  assert(
    burst !== undefined && burst.detail.includes("503 VERIFY_UNAVAILABLE") && burst.detail.includes("409 SLOT_TAKEN"),
    "and names both kinds of refusal",
  );
}

{
  // A winner with no booking row still fails: the SLOT_TAKEN answers then point at
  // nothing.
  const r = broken((i) => {
    i.bookings = i.bookings.filter((b) => b.external_id !== i.burstResults[0]!.attempts[0]!.externalId);
  });
  assert(
    r.findings.some((f) => f.bar === "the burst's winners" && f.detail.includes("no booking row")),
    "a winner with no booking row is caught",
  );
}

// --- BOTH guards must have been seen to refuse (#2274) ------------------------
//
// The run's headline bar is "no two active bookings overlap on one agent", and an
// ABSENCE of overlaps is only evidence if the things that prevent them were shown
// to be working. There are two now, and they answer different questions:
// `bookings_active_slot_uniq` refuses a second booking at the same START, and
// `bookings_active_no_overlap` refuses one OVERLAPPING an existing booking, which
// is the case uniqueness cannot see because appointments are longer than the grid
// they are offered on. A branch missing either one produces a clean looking run
// that proves nothing about the half it lost (L1, L98).

{
  const r = broken((i) => {
    i.overlapConstraintPresent = false;
  });
  assert(
    r.findings.some((f) => f.bar === "bookings_active_no_overlap"),
    "a branch without the overlap constraint is a finding",
  );
  assert(
    r.findings.some((f) => f.detail.includes("proves nothing")),
    "and says an absence of overlaps proves nothing without it",
  );
}

{
  // The two are reported SEPARATELY, because they send a reader to two different
  // migrations and one message answering for the other is how somebody looks in
  // the wrong place (L11).
  const neither = broken((i) => {
    i.slotUniqueIndexPresent = false;
    i.overlapConstraintPresent = false;
  });
  const bars = neither.findings.map((f) => f.bar);
  assert(bars.includes("bookings_active_slot_uniq"), "a branch missing the unique index says so");
  assert(bars.includes("bookings_active_no_overlap"), "and missing the overlap constraint says so too");
  eq(
    new Set(neither.findings.filter((f) => f.bar.startsWith("bookings_active")).map((f) => f.detail))
      .size,
    2,
    "and the two messages are genuinely different",
  );
}

{
  // The other direction (L159): with both proven, neither is a finding, so the
  // controls above are about the flags rather than about the bar always firing.
  const ok = passing();
  const r = judgeBookingRun(ok);
  assert(
    !r.findings.some((f) => f.bar.startsWith("bookings_active")),
    "a run that saw both guards refuse reports neither",
  );
}

// --- CPU is judged only where the reading can be attributed (#2279) -----------
// This is the regression the whole change exists to prevent. The platform query
// had never once returned a reading, so the CPU bar had never once run. Repairing
// the query alone would have flipped it straight from "never concludes" to
// "always fails": `workersInvocationsAdaptive` counts CRON invocations alongside
// fetch ones, and Slate's cron lanes run under a raised ceiling deliberately, so
// production's adaptive p99 on 2026-09-13 was 48.9 SECONDS against the 200ms per
// request budget. A bar that fails every run for a reason nobody should fix is one
// nobody reads by the second week (L36).
{
  const withCrons = broken((i) => {
    // The shape production actually produces: a huge p99 that is entirely the
    // cron lanes, and crons present in the window to prove it. 44.7 s is the
    // production minute lane's seven day maximum (docs/cloudflare-platform-notes.md),
    // inside the margin below.
    i.platform.cpuMsP99 = 48_900;
    i.platform.cron = {
      invocations: 10,
      worstCpuMs: 44_700,
      byCron: { "* * * * *": { invocations: 10, worstCpuMs: 44_700 } },
    };
  });
  assert(
    !bars(withCrons).includes("Worker CPU on the request path"),
    "a p99 dominated by cron invocations is NOT reported as a request path CPU breach",
  );
  assert(
    !bars(withCrons).includes("cron CPU"),
    "and a cron under the platform ceiling is not a finding either",
  );
  eq(withCrons.verdict, "pass", "so a healthy run with busy cron lanes still passes");
}
{
  const cronOverCeiling = broken((i) => {
    i.platform.cpuMsP99 = 130_000;
    i.platform.cron = {
      invocations: 10,
      worstCpuMs: 130_000,
      byCron: { "* * * * *": { invocations: 10, worstCpuMs: 130_000 } },
    };
  });
  assert(
    bars(cronOverCeiling).includes("cron CPU"),
    "a cron lane over the platform ceiling IS a finding",
  );
  assert(
    cronOverCeiling.findings.find((f) => f.bar === "cron CPU")!.detail.includes("* * * * *"),
    "and it NAMES the lane, because that is what a reader acts on",
  );
}
{
  // #2357: a bar AT the kill limit has no margin. Run 34991614423 passed a tick at
  // 119,137 ms against 120,000 with the same words it would have used for 4,000.
  // The cron half now fails past a stated share of the ceiling, and says the share.
  const margin = Math.round(CRON_CPU_MARGIN_SHARE * 120_000);
  const justUnder = broken((i) => {
    i.platform.cron = {
      invocations: 19,
      worstCpuMs: margin,
      byCron: { "* * * * *": { invocations: 19, worstCpuMs: margin } },
    };
  });
  assert(!bars(justUnder).includes("cron CPU"), "a tick exactly AT the margin is not a finding");

  const nearKill = broken((i) => {
    i.platform.cron = {
      invocations: 19,
      worstCpuMs: 119_137,
      byCron: {
        "* * * * *": { invocations: 15, worstCpuMs: 119_137 },
        "*/5 * * * *": { invocations: 4, worstCpuMs: 665 },
      },
    };
  });
  const finding = nearKill.findings.find((f) => f.bar === "cron CPU");
  assert(finding !== undefined, "a tick under the kill limit but past the margin IS a finding");
  assert(finding!.detail.includes("99%"), "and it states the share of the kill limit the tick used");
  assert(finding!.detail.includes("* * * * *"), "and names the lane that reached it");
  assert(
    finding!.detail.includes(String(margin)),
    "and the margin it was judged against, so the bar is never read as the ceiling",
  );
  eq(nearKill.verdict, "fail", "so the run fails rather than passing on one second of headroom");
}
{
  // The share is printed on EVERY run, pass or fail, through one helper so the
  // report and the finding cannot word it two ways (L41).
  eq(
    cronCpuShareText(119_137, 120_000),
    "worst tick 119137ms of CPU, 99% of the 120000ms kill limit",
    "the share line for the measured near kill tick",
  );
  eq(
    cronCpuShareText(4_000, 120_000),
    "worst tick 4000ms of CPU, 3% of the 120000ms kill limit",
    "and for a quiet one, so 3 percent and 99 percent never read alike",
  );
  eq(
    cronCpuShareText(0, 0),
    "worst tick 0ms of CPU, against an unreadable kill limit",
    "an unusable ceiling is said, never divided by",
  );
}
{
  // #2345: the request CPU finding used to call the post response span "the deferred
  // webhook send". The load test Worker has NO webhook subscriber (every confirm in
  // run 34991614423 logged `no subscriber for event`), so that span cannot be the
  // send, and naming a job the run never measured sends a reader to the wrong code.
  const r = broken((i) => {
    i.platform.cpuMsP99 = REQUEST_CPU_P99_MS + 1_000;
  });
  const cpu = r.findings.find((f) => f.bar === "Worker CPU on the request path");
  assert(cpu !== undefined, "a request CPU breach with the startup split read is a finding");
  assert(
    cpu!.detail.includes("AFTER the response had gone"),
    "and it still reports the post response span apart",
  );
  assert(
    !cpu!.detail.includes("which is the deferred webhook send"),
    "without naming a job it did not measure",
  );
  assert(
    cpu!.detail.includes("by job"),
    "and points at the per job line, which is where what that span WAS is measured",
  );
}
{
  // The other direction (L1): with no cron in the window the percentile really is
  // the request path, so the per request budget must still bite.
  const requestCpu = broken((i) => {
    i.platform.cpuMsP99 = REQUEST_CPU_P99_MS + 1;
  });
  assert(
    bars(requestCpu).includes("Worker CPU on the request path"),
    "with no cron in the window the per request budget is still applied",
  );
}
{
  // An unreadable scheduled half cannot be read as "no crons ran", because that is
  // exactly the reading that would let the mixed percentile through as a pass (L98).
  const blindCrons = broken((i) => {
    i.platform.cron = null;
  });
  eq(
    blindCrons.verdict,
    "unmeasured",
    "and a scheduled half that could not be read claims nothing about CPU at all",
  );
}
{
  // The sentinel. A real reading reports `success`; the judge used to call the
  // healthy value `ok`, so the first reading that ever arrived would have made
  // every single healthy invocation a finding.
  const healthy = broken((i) => {
    i.platform.statuses = { success: 610 };
  });
  assert(
    !bars(healthy).includes("platform outcome"),
    "`success` is the healthy status and is never a finding",
  );
}

// --- the overlap count is a measurement, present on a PASSING run (#2323) --------
{
  // The report is built from `measurements`, so a passing run whose measurements
  // carry no overlap count can print nothing about the one number the run exists
  // to produce. On 2026-09-14 the record had to state "0 pairs" from the judge's
  // silence (L98).
  const clean = judgeBookingRun(passing());
  eq(clean.verdict, "pass", "the fixture passes");
  eq(clean.measurements?.overlappingPairs, 0, "and its measurements carry a measured ZERO");
  assert(
    (clean.measurements?.activeBookings ?? 0) > 0,
    "over a denominator, so the zero cannot be read as a run that looked at nothing",
  );
}

// --- #3258: latency is judged against a same day baseline at rest ------------------
//
// The fixed 5s p95 bar failed the 09-15 code on 2026-10-04's environment (7.0s), so a
// run could not pass on its code's merits. With a baseline leg (bookings at rest on the
// same deployment just before the steady pass, since #3517 a warm up of two and then
// twenty measured, one every ten seconds) the pass rule is the
// steady p95 against a multiple of the baseline's median, which the day moves just
// as it moves the steady pass. #3517: the median drops the baseline's warm up, and the
// p95 is ALSO held to a fixed limit that holds whatever the baseline reads. The
// fixtures sit in today's range (a baseline of 0.5 to 1.2s, a p95 of 1.3 to 2.4s);
// the pure rule is driven in scripts/test-loadtest-speed-verdict.ts.
{
  const restFile = (wallMs: number, n = BASELINE_PLANNED, okCount = n): DriverResult => ({
    runId: RUN,
    driver: 0,
    mode: "baseline",
    planned: BASELINE_PLANNED,
    startedAtMs: T0 - 5 * 60_000,
    finishedAtMs: T0 - 60_000,
    attempts: Array.from({ length: n }, (_, k) =>
      attempt(0, k, {
        externalId: `${RUN}-r-0-${k}`,
        wallMs,
        ...(k >= okCount ? { status: 409, outcome: "SLOT_TAKEN" } : {}),
      }),
    ),
  });
  /** A run whose steady p95 is `p95Ms`, with a baseline at rest of `restMs`. */
  const withBaseline = (p95Ms: number, restMs: number, baseline: DriverResult | null = restFile(restMs)) =>
    broken((i) => {
      const all = i.driverResults.flatMap((r) => r.attempts);
      for (const a of all) a.wallMs = Math.round(p95Ms * 0.6);
      for (const a of all.slice(0, Math.ceil(all.length * 0.1))) a.wallMs = p95Ms;
      i.expectedLegs = { ...i.expectedLegs, baseline: true };
      i.baseline = baseline ? { kind: "file", result: baseline } : { kind: "absent" };
    });

  eq(idPrefix(RUN, "baseline"), `${RUN}-r`, "the baseline's bookings carry their own prefix, so no steady id is reused");
  assert(BASELINE_PER_MINUTE * 2 < 15, "the baseline paces well below one steady driver, so it measures the path at rest");
  assert(BASELINE_MIN_OK <= BASELINE_BOOKINGS, "the sample floor is reachable");

  // Today's environment: the steady pass in proportion to the day's rest, and inside
  // the fixed limit.
  const fairDay = withBaseline(1_500, 700);
  assert(!bars(fairDay).includes("latency of successful bookings"), "a p95 within the multiple of the day's rest and the fixed limit passes");
  const lat = fairDay.measurements!.latency!;
  eq(lat.kind, "relative", "judged against the baseline");
  assert(lat.kind === "relative" && lat.fixedPass && lat.fixedLimitMs === STEADY_P95_LIMIT_MS, "and the fixed limit is judged too, as met");
  assert(lat.kind === "relative" && lat.ratioBarMs === Math.round(700 * LOAD_OVER_REST_RATIO_BAR), "the ratio bar is the multiple of the baseline median");

  // The code got slower under load on the same day: the multiple is exceeded, while
  // the p95 is still inside the fixed limit, so only the ratio is named.
  const slowUnderLoad = withBaseline(Math.round(500 * LOAD_OVER_REST_RATIO_BAR) + 100, 500);
  const f = slowUnderLoad.findings.find((x) => x.bar === "latency of successful bookings");
  assert(f !== undefined, "a p95 past the multiple of the day's rest fails");
  assert(
    f !== undefined && f.detail.includes("failed the ratio check") && f.detail.includes(`${STEADY_P95_LIMIT_MS}ms`),
    `naming the ratio and still stating the fixed limit: ${f?.detail}`,
  );

  // #3517: a slow baseline lets a slow run through the ratio (2.0 times), and the
  // fixed limit fails it through the judge, saying which check it was.
  const slowBaseline = withBaseline(STEADY_P95_LIMIT_MS + 600, 1_200);
  const fx = slowBaseline.findings.find((x) => x.bar === "latency of successful bookings");
  assert(
    fx !== undefined && fx.detail.includes("failed the fixed limit") && fx.detail.includes(`${Math.round(1_200 * LOAD_OVER_REST_RATIO_BAR)}ms`),
    `a slow baseline cannot pass a slow run, and the finding states both numbers: ${fx?.detail}`,
  );
  // Both at once, through the judge.
  const overBoth = withBaseline(STEADY_P95_LIMIT_MS + 600, 600).findings.find((x) => x.bar === "latency of successful bookings");
  assert(overBoth !== undefined && overBoth.detail.includes("failed both checks"), `a run over both names both: ${overBoth?.detail}`);
  // The same slow baseline run dispatched with a Google delay (#3490) is judged on the
  // ratio alone, which it passes, because the limit was calibrated with no delay.
  const delayed = broken((i) => {
    const all = i.driverResults.flatMap((r) => r.attempts);
    for (const a of all) a.wallMs = Math.round((STEADY_P95_LIMIT_MS + 600) * 0.6);
    for (const a of all.slice(0, Math.ceil(all.length * 0.1))) a.wallMs = STEADY_P95_LIMIT_MS + 600;
    i.expectedLegs = { ...i.expectedLegs, baseline: true, googleDelayed: true };
    i.baseline = { kind: "file", result: restFile(1_200) };
  });
  assert(!bars(delayed).includes("latency of successful bookings"), "with a Google delay the fixed limit does not fail the run");
  const dl = delayed.measurements!.latency!;
  assert(dl.kind === "relative" && dl.fixedLimitMs === null, "and the judgement records it as not applied");

  // Dan, 2026-10-05: a baseline that is missing, thin, doubled, unreadable or from
  // another run voids the SPEED verdict only. Every other bar is still judged, and the
  // speed result is reported as unmeasured, never as a pass and never as the old bar.
  const unmeasured = (r: ReturnType<typeof judgeBookingRun>, cause: string, label: string) => {
    assert(r.verdict !== "incomplete", `${label}: the run is still judged`);
    assert(!bars(r).includes("latency of successful bookings"), `${label}: and no latency finding is invented`);
    eq(r.measurements?.latency?.kind, "unmeasured", `${label}: the speed result is unmeasured`);
    assert(r.speedUnmeasured?.includes(cause) ?? false, `${label}: saying why (${r.speedUnmeasured})`);
    // #3294 review, L98: every other bar passed, and that is still NOT a pass.
    eq(r.verdict, "unmeasured", `${label}: the run's verdict is unmeasured, never pass`);
    eq(r.exit, JUDGE_EXIT.unmeasured, `${label}: and it exits non zero, so the workflow is not green`);
  };
  unmeasured(withBaseline(3_000, 2_000, null), "no baseline file", "a missing baseline");
  unmeasured(
    withBaseline(1_400, 700, restFile(700, BASELINE_PLANNED, BASELINE_WARMUP + BASELINE_MIN_OK - 1)),
    String(BASELINE_MIN_OK),
    "a thin baseline",
  );
  unmeasured(
    broken((i) => {
      i.expectedLegs = { ...i.expectedLegs, baseline: true };
      i.baseline = { kind: "several", files: ["baseline.json", "baseline-2.json"] };
    }),
    "baseline-2.json",
    "two baseline files",
  );
  unmeasured(
    broken((i) => {
      i.expectedLegs = { ...i.expectedLegs, baseline: true };
      i.baseline = { kind: "unreadable", file: "baseline.json", why: "Unexpected end of JSON input" };
    }),
    "could not be read",
    "a corrupt baseline file",
  );
  unmeasured(
    broken((i) => {
      i.expectedLegs = { ...i.expectedLegs, baseline: true };
      i.baseline = { kind: "file", result: { ...restFile(2_000), runId: "run-older" } };
    }),
    "run-older",
    "a baseline from another run",
  );
  // The other bars still bite on such a run: a 5xx beside a missing baseline fails.
  const failsElsewhere = broken((i) => {
    i.expectedLegs = { ...i.expectedLegs, baseline: true };
    i.baseline = { kind: "absent" };
    i.driverResults[0]!.attempts[0]!.status = 500;
    i.driverResults[0]!.attempts[0]!.outcome = "INTERNAL";
    i.bookings = i.bookings.filter((b) => b.external_id !== `${RUN}-0-0`);
    i.bookingIdsWithBusyBlock = i.bookings.map((b) => b.id);
  });
  eq(failsElsewhere.verdict, "fail", "and a run with a real finding beside an unmeasured speed still fails");
  eq(failsElsewhere.exit, JUDGE_EXIT.fail, "a real failure outranks the void speed verdict");
  assert(JUDGE_EXIT.unmeasured !== 0, "the unmeasured exit is never the pass exit");
  eq(fairDay.speedUnmeasured, null, "a measured run carries no unmeasured note");
  const vline = (verdict: string, speed: string | null, platform: string | null = null) =>
    verdictText({ verdict, speedUnmeasured: speed, platformUnmeasured: platform, burstsUnconcluded: [], measurements: null });
  eq(vline("pass", null), "Verdict: **PASS**.", "a measured run's verdict line is unchanged");
  const voided = vline("unmeasured", "no baseline file arrived");
  assert(
    voided.startsWith("Verdict: **UNMEASURED**") && voided.includes("every other bar passed") && voided.includes("no baseline file arrived"),
    `a void speed verdict on an otherwise clean run says so in the verdict line: ${voided}`,
  );
  assert(!/PASS/.test(voided), "and never says pass");
  const failedToo = vline("fail", "no baseline file arrived");
  assert(failedToo.startsWith("Verdict: **FAIL**") && failedToo.includes("no baseline file arrived"), `a failed run says the speed was not measured either: ${failedToo}`);

  // #3294 review, L11: with the platform ALSO unmeasured, its bars were never judged,
  // so the line names each unmeasured cause and claims a pass only for what was judged.
  const both = vline("unmeasured", "no baseline file arrived", "the analytics API reported no invocation outcomes");
  assert(!both.includes("every other bar passed"), `never claims every other bar passed when the platform was not judged: ${both}`);
  assert(both.includes("no baseline file arrived") && both.includes("no invocation outcomes"), `names both causes: ${both}`);
  assert(both.includes("the bars that were judged passed"), `and claims a pass only for the bars judged: ${both}`);
  const platformOnly = vline("unmeasured", null, "the analytics API reported no invocation outcomes");
  assert(platformOnly.includes("platform limits") && platformOnly.includes("the bars that were judged passed"), `the platform alone is named: ${platformOnly}`);

  // Through the judge: a missing baseline and an empty platform histogram together.
  const doubleBlind = broken((i) => {
    i.expectedLegs = { ...i.expectedLegs, baseline: true };
    i.baseline = { kind: "absent" };
    i.platform = { ...i.platform, statuses: {} };
  });
  eq(doubleBlind.verdict, "unmeasured", "a run blind on speed and the platform is unmeasured");
  assert(doubleBlind.platformUnmeasured !== null, "and records that the platform was unmeasured");
  const text = verdictText(doubleBlind);
  assert(!text.includes("every other bar passed") && text.includes("no baseline file"), `its verdict line names both and claims no blanket pass: ${text}`);

  // #3294 review: EXPECT_BASELINE is "1" or unset, and anything else is refused by name.
  eq(expectBaselineFrom(undefined), { ok: true, expected: false }, "unset is a hand run");
  eq(expectBaselineFrom(""), { ok: true, expected: false }, "empty is a hand run");
  eq(expectBaselineFrom("1"), { ok: true, expected: true }, "1 expects a baseline");
  for (const bad of ["true", "yes", "0", " 1x"]) {
    const r = expectBaselineFrom(bad);
    assert(!r.ok && r.why.includes(JSON.stringify(bad)), `${JSON.stringify(bad)} is refused, naming it`);
  }

  // #3294 review: a malformed baseline is unreadable, never a crash, and never cast blind.
  const shape = (parsed: unknown) => baselineReading([{ name: "baseline.json", parsed }]);
  for (const [label, parsed, field] of [
    ["no attempts", { mode: "baseline", runId: RUN }, "attempts"],
    ["attempts not a list", { mode: "baseline", runId: RUN, attempts: "x" }, "attempts"],
    ["no run id", { ...restFile(2_000), runId: undefined }, "runId"],
    ["an attempt with no status", { ...restFile(2_000), attempts: [{ wallMs: 10 }] }, "status"],
    ["an attempt with no wall time", { ...restFile(2_000), attempts: [{ status: 200 }] }, "wallMs"],
    // #3517: the warm up is dropped by position, so a booking with none is unreadable.
    ["an attempt with no position", { ...restFile(2_000), attempts: [{ status: 200, wallMs: 10 }] }, "position n"],
  ] as [string, unknown, string][]) {
    const r = shape(parsed);
    assert(r.kind === "unreadable" && r.why.includes(field), `${label} is unreadable, naming ${field}: ${JSON.stringify(r)}`);
  }
  // A results directory that cannot be listed is its own reason, not "no baseline file".
  const unlisted = baselineReading([], "EACCES: permission denied");
  eq(unlisted, { kind: "unlisted", why: "EACCES: permission denied" }, "an unlistable directory is its own reading");
  unmeasured(
    broken((i) => {
      i.expectedLegs = { ...i.expectedLegs, baseline: true };
      i.baseline = unlisted;
    }),
    "could not be listed",
    "an unlistable results directory",
  );

  // How the judge entry turns the results directory into a reading.
  const good = restFile(2_000);
  eq(baselineReading([{ name: "baseline.json", parsed: good }]), { kind: "file", result: good }, "one baseline file is the reading");
  eq(baselineReading([{ name: "driver-0.json", parsed: { mode: "steady" } }]), { kind: "absent" }, "no baseline file is absent");
  eq(
    baselineReading([{ name: "baseline.json", parsed: good }, { name: "baseline-again.json", parsed: good }]),
    { kind: "several", files: ["baseline.json", "baseline-again.json"] },
    "two baseline files are refused, never the first silently taken",
  );
  eq(
    baselineReading([{ name: "baseline.json", error: "Unexpected end of JSON input" }]),
    { kind: "unreadable", file: "baseline.json", why: "Unexpected end of JSON input" },
    "a corrupt baseline.json is unreadable, not absent",
  );
  eq(
    baselineReading([{ name: "driver-9.json", error: "boom" }]),
    { kind: "absent" },
    "a corrupt file that is not a baseline is not the baseline's problem",
  );

  // A hand run with no baseline leg keeps the absolute bar as THE bar, and says why.
  const hand = broken((i) => {
    const all = i.driverResults.flatMap((r) => r.attempts);
    for (const a of all.slice(0, Math.ceil(all.length * 0.1))) a.wallMs = OK_P95_MS + 1000;
  });
  const hf = hand.findings.find((x) => x.bar === "latency of successful bookings");
  assert(hf !== undefined && hf.detail.includes("no same day baseline"), "a run without a baseline is held to the absolute bar, and says so");
  eq(hand.measurements!.latency!.kind, "absolute", "and records which rule judged it");

  // The report says which rule judged the run: with a baseline, the ratio and the fixed
  // limit beside it (#3517); on a hand run, the fixed 5s bar and why.
  const line = latencyReportLine(fairDay.measurements!.latency!);
  assert(line.includes("700ms") && line.includes(`${LOAD_OVER_REST_RATIO_BAR} times`), `the report names the baseline and the multiple: ${line}`);
  assert(line.includes(`${STEADY_P95_LIMIT_MS}ms fixed limit`), `and the fixed limit beside it (#3517): ${line}`);
  assert(latencyReportLine(hand.measurements!.latency!).includes("no same day baseline"), "a hand run's report says why the fixed bar judged it");

  // #3258 follow up, L11: the latency report line must not claim every other bar was
  // judged when the platform half was unmeasured too; it says what the verdict line says.
  const voidOnly = latencyReportLine({ kind: "unmeasured", why: "no baseline file arrived" }, null);
  assert(voidOnly.includes("every other bar was judged"), `with only speed void, the other bars were judged: ${voidOnly}`);
  const voidBoth = latencyReportLine({ kind: "unmeasured", why: "no baseline file arrived" }, "the analytics API reported no invocation outcomes");
  assert(!voidBoth.includes("every other bar was judged"), `with the platform unmeasured too, no blanket claim: ${voidBoth}`);
  assert(voidBoth.includes("platform limits were UNMEASURED") && voidBoth.includes("no invocation outcomes"), `and it names the platform cause: ${voidBoth}`);
}

// =====================================================================================
// The shared confirm line, proved by the burst (#3325)
// =====================================================================================
//
// Three bursts a run, each split across two sibling codes, each judged on its own,
// and two new clauses per burst: every confirm took the SHARED line, and every
// SLOT_TAKEN was answered within BURST_LOSER_LAG_MS of the LAST winner on the
// deployment's own clock. Each clause is driven in BOTH directions from the passing
// run (L1), on the artifact shape the judge actually reads: burst driver files whose
// attempts carry echoes built and read by the real contract.

const SIBLINGS = ["120", "121"] as const;
const LEG_SLOTS = ["2026-09-16T15:00:00.000Z", "2026-09-16T16:10:00.000Z", "2026-09-16T17:20:00.000Z"];
/** Each leg's moment on the deployment's clock, a minute apart. */
const legAt = (leg: number) => BURST_AT + leg * 60_000;

/**
 * One burst driver's file for one leg: twenty five requests split across the two
 * siblings exactly as the driver splits them, the first request of driver 0 winning
 * and every other one refused SLOT_TAKEN, all answered within half a second.
 */
function legFile(leg: number, driver: number): DriverResult {
  const attempts = Array.from({ length: 25 }, (_, i) => {
    const n = leg * 25 + i;
    const won = driver === 0 && i === 0;
    return attempt(driver, n, {
      code: burstCodeFor(SIBLINGS, driver, i),
      externalId: externalIdFor(idPrefix(RUN, "burst"), driver, n),
      startIso: LEG_SLOTS[leg]!,
      status: won ? 200 : 409,
      outcome: won ? "booked" : "SLOT_TAKEN",
      echo: echoOf({}, legAt(leg) + 800 + (won ? 0 : 100 + driver * 30 + i * 10)),
    });
  });
  return {
    runId: RUN,
    driver,
    mode: "burst",
    planned: 25,
    startedAtMs: legAt(leg) - 1000,
    finishedAtMs: legAt(leg) + 2000,
    burstLeg: { index: leg, of: 3, slot: LEG_SLOTS[leg]!, codes: [...SIBLINGS], startAtMs: legAt(leg) },
    // #3429: every driver read the rule and probed the slot once the burst settled.
    crowdRule: crowdRuleOf("walks"),
    probe: probeOf(burstCodeFor(SIBLINGS, driver, 0), legAt(leg), { bookable: false, reason: "slot_taken" }),
    attempts,
  };
}

/** The passing run, with the workflow's real burst shape: three legs of four drivers. */
function threeBursts(): JudgeInput {
  const input = passing();
  input.burstResults = [0, 1, 2].flatMap((leg) => [0, 1, 2, 3].map((d) => legFile(leg, d)));
  // Each leg's winner booked the pool's one agent, an hour apart, so nothing overlaps.
  const winners = input.burstResults.flatMap((r) => r.attempts.filter((a) => a.status === 200));
  input.bookings = [
    ...input.driverResults.flatMap((r) => r.attempts.map((a) => bookingFor(a))),
    ...winners.map((a) => bookingFor(a, { assigned_user_id: "agent-beyond" })),
  ];
  input.bookingIdsWithBusyBlock = input.bookings.map((b) => b.id);
  input.expectedLegs = { ...input.expectedLegs, burstDrivers: 4, bursts: 3 };
  return input;
}

function brokenThree(mutate: (i: JudgeInput) => void) {
  const input = threeBursts();
  mutate(input);
  return judgeBookingRun(input);
}

/** The attempts of one leg, across every driver. */
const legAttempts = (i: JudgeInput, leg: number) =>
  i.burstResults.filter((r) => (r.burstLeg?.index ?? 0) === leg).flatMap((r) => r.attempts);

// --- the three leg run passes, and each leg is read on its own ------------------------
{
  const r = judgeBookingRun(threeBursts());
  eq(`${r.verdict} ${bars(r).join("|")}`, "pass ", "three clean bursts of four drivers pass");
  const legs = r.measurements!.bursts;
  eq(legs.length, 3, "and the report carries one reading per burst");
  eq(legs.map((l) => l.attempts).join(","), "100,100,100", "each burst read on its own hundred requests");
  eq(legs.map((l) => l.failed.length).join(","), "0,0,0", "with nothing failed in any of them");
  eq(legs[1]!.codes, { "120": 50, "121": 50 }, "and the split across the two siblings is reported");
}

// --- a. every burst confirm took the SHARED line ----------------------------------------
{
  const one = brokenThree((i) => {
    legAttempts(i, 1)[7]!.echo = echoOf({ line: "isolate", reason: "off" }, legAt(1) + 900);
  });
  const f = one.findings.find((x) => x.bar === "the burst's line");
  assert(f !== undefined, "one burst confirm served by the per isolate line fails the line clause");
  assert(
    f !== undefined && f.detail.includes("burst 2 of 3") && f.detail.includes("isolate/off 1") && f.detail.includes("shared/ok 99"),
    `naming the burst and the count per line and reason (got: ${f?.detail})`,
  );
  eq(one.verdict, "fail", "and the run fails");
  eq(
    one.measurements!.bursts.map((l) => l.failed.join("+")).join(","),
    ",the burst's line,",
    "and only that burst is marked failed",
  );
}

{
  // The state every run is in until the shared line ships: no line header at all.
  // That must FAIL by name, never pass for want of anything to object to (L98).
  const silent = brokenThree((i) => {
    for (const r of i.burstResults) for (const a of r.attempts) a.echo = echoOf(null, a.echo!.answeredAtMs.state === "read" ? a.echo!.answeredAtMs.value : null);
  });
  const lines = silent.findings.filter((x) => x.bar === "the burst's line");
  eq(lines.length, 3, "every burst fails the line clause when the deployment says nothing");
  assert(
    lines.every((x) => x.detail.includes("the deployment did not say which line served the burst")),
    `in those words (got: ${lines[0]?.detail})`,
  );
}

{
  const garbled = brokenThree((i) => {
    legAttempts(i, 0)[3]!.echo = readLoadtestEcho(
      new Headers([
        ["x-loadtest-confirm-line", "Shared"],
        ["x-loadtest-answered-at", String(legAt(0) + 900)],
      ]),
    );
  });
  const f = garbled.findings.find((x) => x.bar === "the burst's line");
  assert(
    f !== undefined && f.detail.includes('unreadable line "Shared" 1'),
    `a line value the contract does not know fails, quoted rather than dropped (got: ${f?.detail})`,
  );
}

{
  const fallback = brokenThree((i) => {
    for (const a of legAttempts(i, 2).slice(0, 4)) {
      a.echo = echoOf({ line: "fallback", reason: "reach-timeout", key: "code" }, legAt(2) + 900);
    }
  });
  const f = fallback.findings.find((x) => x.bar === "the burst's line");
  assert(
    f !== undefined && f.detail.includes("fallback/reach-timeout 4") && f.detail.includes("burst 3 of 3"),
    `a burst that fell back to the per isolate line names the fallback and why (got: ${f?.detail})`,
  );
}

{
  // The ladder share is REPORTED, never barred: a request that could not take a
  // ladder key still took the shared line, under its code.
  const coded = brokenThree((i) => {
    for (const a of legAttempts(i, 0).slice(0, 10)) a.echo = echoOf({ key: "code" }, a.echo!.answeredAtMs.state === "read" ? a.echo!.answeredAtMs.value : null);
  });
  eq(coded.verdict, "pass", "a burst partly on code keys still passes");
  eq(coded.measurements!.bursts[0]!.ladderKeys, 90, "and reports 90 of its 100 confirms on a ladder key");
  eq(coded.measurements!.bursts[1]!.ladderKeys, 100, "and 100 of 100 for a burst wholly on the ladder");
}

// --- b. every SLOT_TAKEN within BURST_LOSER_LAG_MS of the LAST 200 ----------------------
{
  eq(BURST_LOSER_LAG_MS, 2_000, "the bound is two seconds, a named constant");

  const atBound = brokenThree((i) => {
    const loser = legAttempts(i, 0).find((a) => a.status === 409)!;
    loser.echo = echoOf({}, legAt(0) + 800 + BURST_LOSER_LAG_MS);
  });
  eq(atBound.verdict, "pass", "a loser answered exactly at the bound after the last winner passes");

  const late = brokenThree((i) => {
    const loser = legAttempts(i, 1).find((a) => a.status === 409)!;
    loser.echo = echoOf({}, legAt(1) + 800 + BURST_LOSER_LAG_MS + 1);
  });
  const f = late.findings.find((x) => x.bar === "the burst's speed");
  assert(f !== undefined, "a loser answered one millisecond past the bound fails the speed clause");
  assert(
    f !== undefined && f.detail.includes("burst 2 of 3") && f.detail.includes(`${BURST_LOSER_LAG_MS + 1}ms after`),
    `naming the burst and how far behind the last winner it came (got: ${f?.detail})`,
  );
}

{
  // Measured from the LAST winner, not the first: with one agent per rung, winners
  // land at different moments, and a loser told taken just after the last of them was
  // answered promptly.
  const twoWinners = brokenThree((i) => {
    const second = legAttempts(i, 0).find((a) => a.status === 409)!;
    second.status = 200;
    second.outcome = "booked";
    second.echo = echoOf({}, legAt(0) + 3_000);
    for (const a of legAttempts(i, 0)) if (a.status === 409) a.echo = echoOf({}, legAt(0) + 4_500);
    i.bookings.push(bookingFor(second, { assigned_user_id: "agent-achieve-low" }));
    i.bookingIdsWithBusyBlock = i.bookings.map((b) => b.id);
  });
  eq(
    twoWinners.verdict,
    "pass",
    "losers 3.7s after the first winner and 1.5s after the last are prompt",
  );
}

{
  const unstamped = brokenThree((i) => {
    legAttempts(i, 2)[5]!.echo = echoOf({}, null);
  });
  const f = unstamped.findings.find((x) => x.bar === "the burst's speed");
  assert(
    f !== undefined && f.detail.includes("could not be measured") && f.detail.includes("1 absent"),
    `a burst answer with no stamp FAILS as unmeasured, never passes (got: ${f?.detail})`,
  );

  const garbled = brokenThree((i) => {
    legAttempts(i, 2)[5]!.echo = readLoadtestEcho(
      new Headers([...confirmLineEchoHeaders({ line: "shared", reason: "ok", key: "ladder", lineMs: 30 }), ["x-loadtest-answered-at", "soon"]]),
    );
  });
  const g = garbled.findings.find((x) => x.bar === "the burst's speed");
  assert(
    g !== undefined && g.detail.includes("could not be measured") && g.detail.includes("1 unreadable"),
    `and so does one whose stamp cannot be read (got: ${g?.detail})`,
  );

  const unanswered = brokenThree((i) => {
    const a = legAttempts(i, 2)[6]!;
    a.status = 0;
    a.outcome = "timed-out";
    a.echo = null;
  });
  const u = unanswered.findings.find((x) => x.bar === "the burst's speed");
  assert(
    u !== undefined && u.detail.includes("could not be measured"),
    "and so does a request that got no answer at all, beside the losers finding it also makes",
  );
  // #3337 review, L11: a request with no reply is not an answer missing its stamp. The
  // reason names what happened, so nobody goes looking for a header fault.
  assert(
    u !== undefined && u.detail.includes("1 of 100 burst requests got no reply") && !u.detail.includes("stamp"),
    `naming the unanswered request as unanswered, not as an unstamped answer (got: ${u?.detail})`,
  );
  const both = brokenThree((i) => {
    const a = legAttempts(i, 2)[6]!;
    a.status = 0;
    a.outcome = "timed-out";
    a.echo = null;
    legAttempts(i, 2)[5]!.echo = echoOf({}, null);
  });
  const b = both.findings.find((x) => x.bar === "the burst's speed");
  assert(
    b !== undefined &&
      b.detail.includes("1 of 100 burst requests got no reply") &&
      b.detail.includes("1 of 99 burst answers carried no readable"),
    `and with both, each is counted against its own population (got: ${b?.detail})`,
  );
}

{
  const noWinner = brokenThree((i) => {
    for (const a of legAttempts(i, 0)) {
      a.status = 409;
      a.outcome = "SLOT_TAKEN";
    }
  });
  assert(
    noWinner.findings.some(
      (x) => x.bar === "the burst's speed" && x.detail.includes("burst 1 of 3") && x.detail.includes("no request was answered 200"),
    ),
    "a burst nobody won cannot measure its losers against a winner, and says so rather than passing",
  );

  const noLoser = brokenThree((i) => {
    for (const a of legAttempts(i, 1)) {
      a.status = 200;
      a.outcome = "booked";
      i.bookings.push(bookingFor(a, { assigned_user_id: `agent-${a.externalId}` }));
    }
    i.bookingIdsWithBusyBlock = i.bookings.map((b) => b.id);
  });
  assert(
    noLoser.findings.some(
      (x) => x.bar === "the burst's speed" && x.detail.includes("burst 2 of 3") && x.detail.includes("no request was refused SLOT_TAKEN"),
    ),
    "and a burst nobody lost never tested how fast losers are answered, so it is not a pass either (L98)",
  );
}

// --- c. any burst failing fails the run, and the report names which ---------------------
{
  const missedOne = brokenThree((i) => {
    const file = i.burstResults.find((r) => r.burstLeg?.index === 1 && r.driver === 2)!;
    file.burstSkipped = "missed";
    file.attempts = [];
  });
  eq(missedOne.verdict, "fail", "one driver missing one burst fails the run");
  const burstBars = missedOne.findings.filter((x) => x.bar.startsWith("the burst"));
  eq(burstBars.length, 1, "with one finding, the shortfall, and no contention question asked of that burst");
  assert(burstBars[0]!.detail.startsWith("burst 2 of 3"), `naming which burst (got: ${burstBars[0]?.detail})`);
  eq(
    missedOne.measurements!.bursts.map((l) => (l.failed.length > 0 ? "x" : "ok")).join(","),
    "ok,x,ok",
    "and the other two bursts are still judged, and pass",
  );
}

{
  // A short burst must not stop the bursts AFTER it being asked their questions. A
  // later burst that passes reads the same judged or skipped, so this one fails.
  const shortThenLate = brokenThree((i) => {
    const file = i.burstResults.find((r) => r.burstLeg?.index === 0 && r.driver === 1)!;
    file.burstSkipped = "missed";
    file.attempts = [];
    legAttempts(i, 2).find((a) => a.status === 409)!.echo = echoOf({}, legAt(2) + 9_000);
  });
  assert(
    shortThenLate.findings.some((x) => x.bar === "the burst" && x.detail.startsWith("burst 1 of 3")) &&
      shortThenLate.findings.some((x) => x.bar === "the burst's speed" && x.detail.startsWith("burst 3 of 3")),
    "a burst short of a driver is failed, and the bursts after it are still judged",
  );
}

{
  const lostLeg = brokenThree((i) => {
    i.burstResults = i.burstResults.filter((r) => r.burstLeg?.index !== 2);
  });
  assert(
    lostLeg.findings.some((x) => x.bar === "the burst" && x.detail.startsWith("burst 3 of 3") && x.detail.includes("0 burst driver files, expected 4")),
    "a configured burst whose files never arrived fails by name, never counts as absent",
  );
}

{
  // Two bursts failing for two different reasons each carry their own finding.
  const two = brokenThree((i) => {
    legAttempts(i, 0)[4]!.echo = echoOf({ line: "isolate", reason: "unbound" }, legAt(0) + 900);
    legAttempts(i, 2).find((a) => a.status === 409)!.echo = echoOf({}, legAt(2) + 9_000);
  });
  assert(
    two.findings.some((x) => x.bar === "the burst's line" && x.detail.startsWith("burst 1 of 3")) &&
      two.findings.some((x) => x.bar === "the burst's speed" && x.detail.startsWith("burst 3 of 3")),
    "two failing bursts are each named with their own clause",
  );
  eq(
    two.measurements!.bursts.map((l) => l.failed.join("+") || "ok").join(","),
    "the burst's line,ok,the burst's speed",
    "and the per burst reading says which failed and why",
  );
}

{
  // The contention bars are per burst too: an agent holding two bookings in burst 3
  // is named as burst 3, while bursts 1 and 2 pass.
  const doubled = brokenThree((i) => {
    const second = legAttempts(i, 2).find((a) => a.status === 409)!;
    second.status = 200;
    second.outcome = "booked";
    second.echo = echoOf({}, legAt(2) + 820);
    i.bookings.push(bookingFor(second, { assigned_user_id: "agent-beyond" }));
    i.bookingIdsWithBusyBlock = i.bookings.map((b) => b.id);
  });
  const f = doubled.findings.find((x) => x.bar === "the burst's winners");
  assert(f !== undefined && f.detail.startsWith("burst 3 of 3"), `a double booking names its burst (got: ${f?.detail})`);
}

{
  // Two files claiming one driver within ONE burst is incomplete; the same driver
  // across three bursts is the plan.
  const dup = brokenThree((i) => {
    const file = i.burstResults.find((r) => r.burstLeg?.index === 0 && r.driver === 3)!;
    file.driver = 2;
  });
  eq(dup.verdict, "incomplete", "two files for one driver in one burst is incomplete");
  assert(
    dup.incomplete.some((w) => w.includes("burst 1")),
    `naming the burst (got: ${dup.incomplete.join(" | ")})`,
  );
}

// --- d. the steady pass's line, reported and never barred --------------------------------
{
  const r = judgeBookingRun(passing());
  const steady = r.measurements!.steadyLine;
  eq(steady.answered, 4 * PER_DRIVER, "every steady answer is counted");
  eq(steady.byLineReason, { "shared/ok": 4 * PER_DRIVER }, "by line and reason");
  eq(steady.lineMs?.p50, 40, "with the time the line added, p50");
  eq(steady.lineMs?.p95, 40, "and p95");
}

{
  const mixed = broken((i) => {
    const all = i.driverResults.flatMap((d) => d.attempts);
    all.forEach((a, n) => {
      a.echo =
        n % 10 === 0
          ? echoOf({ line: "isolate", reason: "off", lineMs: 0 }, a.sentAtMs + 400)
          : n % 10 === 1
            ? echoOf(null, a.sentAtMs + 400)
            : echoOf({ lineMs: 20 + (n % 100) }, a.sentAtMs + 400);
    });
  });
  eq(mixed.verdict, "pass", "the steady pass's line never fails a run: it is a report, not a bar");
  const steady = mixed.measurements!.steadyLine;
  eq(steady.byLineReason["isolate/off"], 60, "a tenth on the per isolate line, counted by reason");
  eq(steady.notSaid, 60, "and the answers that carried no line header are counted, not dropped");
  assert(steady.lineMs !== null && steady.lineMs.p95 > steady.lineMs.p50, "the percentiles come from the readings");
  eq(steady.lineMsUnread, 60, "and an answer with no time header is counted as unread, never as zero");
}

{
  const none = broken((i) => {
    for (const d of i.driverResults) for (const a of d.attempts) a.echo = echoOf(null, null);
  });
  eq(none.measurements!.steadyLine.lineMs, null, "with no time header anywhere the percentile is null, never zero");
  eq(none.measurements!.steadyLine.notSaid, 4 * PER_DRIVER, "and every answer is counted as not saying");
}

// --- the report says which burst failed, in its own words ----------------------------
{
  const clean = judgeBookingRun(threeBursts()).measurements!;
  eq(burstsSummaryText(clean.bursts), "the bursts: 3 judged, and every one passed", "a clean run says all three passed");
  const two = brokenThree((i) => {
    legAttempts(i, 0)[4]!.echo = echoOf({ line: "isolate", reason: "unbound" }, legAt(0) + 900);
    legAttempts(i, 2).find((a) => a.status === 409)!.echo = echoOf({}, legAt(2) + 9_000);
  }).measurements!;
  const summary = burstsSummaryText(two.bursts);
  assert(
    summary.includes("2 of 3 FAILED") && summary.includes("burst 1 of 3") && summary.includes("burst 3 of 3") && !summary.includes("burst 2 of 3"),
    `a run with two failing bursts names exactly those two (got: ${summary})`,
  );
  const leg = burstLegText(two.bursts[2]!);
  assert(leg.includes("FAILED (the burst's speed)") && leg.includes("120 50, 121 50"), `each burst's line says its verdict and its split (got: ${leg})`);
  assert(burstLegText(two.bursts[1]!).includes("passed"), "and a passing burst says it passed");
  assert(burstLegText(clean.bursts[0]!).includes("ladder key on 100 of 100 (100.0%)"), "with its ladder share");
  eq(burstsSummaryText([]), null, "a run with no burst leg says nothing about bursts");
  const steady = steadyLineText(clean.steadyLine);
  assert(
    steady.includes("not a bar") && steady.includes("p50 40ms, p95 40ms") && steady.includes("absolute time the line added"),
    `the steady line says it is a report and gives the absolute time the line added (got: ${steady})`,
  );
}

// --- a file written before #3325 carries no echo at all, and is read as not said ------
{
  // Driver files from before the echo existed have no `echo` field, and a hand built
  // input may omit it. That must read as the deployment saying nothing, never crash
  // the judge, which would leave the run with no verdict at all (L98).
  const old = broken((i) => {
    for (const d of i.driverResults) for (const a of d.attempts) delete (a as { echo?: unknown }).echo;
    for (const b of i.burstResults) for (const a of b.attempts) delete (a as { echo?: unknown }).echo;
  });
  eq(old.measurements!.steadyLine.notSaid, 4 * PER_DRIVER, "a steady attempt with no echo field counts as not said");
  eq(old.measurements!.steadyLine.lineMs, null, "with no time read");
  assert(
    old.findings.some((f) => f.bar === "the burst's line" && f.detail.includes("the deployment did not say which line served the burst")),
    "and a burst with no echo fields fails the line clause by name",
  );
  assert(
    old.findings.some((f) => f.bar === "the burst's speed" && f.detail.includes("could not be measured")),
    "and the speed clause as unmeasured",
  );
}

// --- #3354: the report's span line, which splits the wait before the profile -------
{
  const reading = startupReading([
    ...Array.from({ length: 20 }, () => ({
      handlerMs: 900,
      beforeMs: 500,
      cold: false,
      answer: { wait_auth_ms: 100, wait_line_ms: 200, wait_total_ms: 400, isolate_invocation_index: 5 },
    })),
    { handlerMs: 900, beforeMs: 1_500, cold: true, answer: { wait_route_ms: 600, wait_auth_ms: 300, wait_line_ms: 500, wait_total_ms: 1_500, isolate_invocation_index: 0 } },
    { handlerMs: 900, beforeMs: 1_100, cold: true },
    // #3418: no invocation index, so on neither side.
    { handlerMs: 900, beforeMs: 700, cold: false, index: null },
  ]);
  const text = waitSpanText(reading);
  assert(/cold n=2, 2 marked/.test(text), `the cold confirms are the Worker's first requests, and how many carried marks (got: ${text})`);
  assert(/route p50 600ms/.test(text), `a cold confirm's route span is reported (got: ${text})`);
  assert(/warm n=20, 20 marked/.test(text), `and the warm ones (got: ${text})`);
  assert(/auth p50 100ms p95 100ms/.test(text), `with each span's median and p95, through the judge's own percentile (got: ${text})`);
  // #3418: the cold n IS the first request count, so the line no longer prints it a
  // second time in other words; a confirm on neither side is named instead.
  assert(!/invocation index were their isolate's first request/.test(text), `the first request count is not printed twice (got: ${text})`);
  assert(/1 with no invocation index on neither side/.test(text), `a confirm with no index is named (got: ${text})`);

  // "marked" counts the confirms that carried marks, not the longest span list: a
  // confirm that carried only an invocation index is marked too (#3358 review).
  const partly = waitSpanText(
    startupReading([
      { handlerMs: 900, beforeMs: 1_500, cold: true, answer: { wait_auth_ms: 300, isolate_invocation_index: 0 } },
      { handlerMs: 900, beforeMs: 1_400, cold: true, answer: { isolate_invocation_index: 0 } },
      { handlerMs: 900, beforeMs: 500, cold: false, answer: { wait_auth_ms: 100 } },
    ]),
  );
  assert(/cold n=2, 2 marked/.test(partly), `both cold confirms carried marks, one of them only an index (got: ${partly})`);
  assert(/warm n=1, 1 marked/.test(partly), `and the warm one is counted on its own side (got: ${partly})`);

  const unmarked = waitSpanText(startupReading([{ handlerMs: 900, beforeMs: 500, cold: false, index: null }]));
  assert(/no confirm carried marks/.test(unmarked), `a run with no marks says the wait was not split, never a zero (got: ${unmarked})`);
  assert(/not read/.test(waitSpanText(null)), "and a run with no archive says so");
}

// --- #3436: the isolate's own start, before the Worker's entry, as its own span --------
// Every span starts at the Worker's entry, so on run 37520312761 the four first requests'
// 585 to 1,021ms before it was in no span, and "whole" (p95 1780ms) read as the whole of
// a cold wait whose p95 was 2801ms. The line now leads each side with the isolate start,
// measured from the invocation's start to the entry stamp, and says how many carried no
// stamp rather than reading them as zero (L622).
{
  // That run's four first requests and two of its warm confirms: before the profile, the
  // marks' whole span, and where the entry sat (the fixtures' event starts at 0).
  const cold = [
    { before: 1_121, whole: 510 },
    { before: 1_482, whole: 897 },
    { before: 1_502, whole: 864 },
    { before: 2_801, whole: 1_780 },
  ];
  const rows = [
    ...cold.map((c) => ({ handlerMs: 2_000, beforeMs: c.before, cold: true, answer: { wait_total_ms: c.whole, wait_entry_at_ms: c.before - c.whole } })),
    { handlerMs: 2_000, beforeMs: 1_107, cold: false, answer: { wait_total_ms: 1_107, wait_entry_at_ms: 0 } },
    { handlerMs: 2_000, beforeMs: 859, cold: false, answer: { wait_total_ms: 858, wait_entry_at_ms: 1 } },
  ];
  const text = waitSpanText(startupReading(rows));
  const p = percentiles([611, 585, 638, 1_021])!;
  assert(text.includes(`cold n=4, 4 marked: isolate start p50 ${p.p50}ms p95 ${p.p95}ms, `), `the cold side leads with the isolate start, through the judge's own percentile (got: ${text})`);
  const w = percentiles([0, 1])!;
  assert(text.includes(`warm n=2, 2 marked: isolate start p50 ${w.p50}ms p95 ${w.p95}ms, `), `and so does the warm side, where it is next to nothing (got: ${text})`);
  assert(/whole from the Worker's entry p50/.test(text), `the whole span says where it starts, so it is not read as the whole wait (got: ${text})`);
  assert(!/no entry stamp/.test(text), `nothing is named missing when every confirm carried the stamp (got: ${text})`);

  // A confirm with no entry stamp is counted on its side, never read as zero.
  const some = waitSpanText(startupReading([...rows, { handlerMs: 2_000, beforeMs: 1_400, cold: true, answer: { wait_total_ms: 800 } }]));
  assert(some.includes(`cold n=5, 5 marked: isolate start p50 ${p.p50}ms p95 ${p.p95}ms (1 with no entry stamp)`), `a cold confirm with no stamp is counted, the span read from the other four (got: ${some})`);

  // An archive from before the stamp existed: measured nowhere, said so, never a zero.
  const none = waitSpanText(startupReading(cold.map((c) => ({ handlerMs: 2_000, beforeMs: c.before, cold: true, answer: { wait_total_ms: c.whole } }))));
  assert(
    /cold n=4, 4 marked: isolate start not measured, none of the 4 carried the Worker's entry stamp \(a deployment with #3436 writes it\)/.test(none),
    `a run whose confirms carried no stamp says the isolate start was not measured (got: ${none})`,
  );
  assert(!/isolate start p50 0ms/.test(none), `and never reports a zero (got: ${none})`);

  // A stamp before the invocation began is two clocks disagreeing, counted, not read.
  const early = waitSpanText(startupReading([...rows, { handlerMs: 2_000, beforeMs: 1_400, cold: true, answer: { wait_total_ms: 800, wait_entry_at_ms: -3 } }]));
  assert(/\(1 stamped before its invocation began\)/.test(early), `a stamp earlier than the invocation is named (got: ${early})`);

  // The cold after deploy line carries the same span, by the same clause.
  const result = { mode: "cold" as const, planned: 4, attempts: [1, 2, 3, 4].map((i) => ({ i, slot: { code: "112", start: `s${i}` }, deployOk: true, version: "unknown", sentAtMs: i, status: 200, outcome: "created" })) };
  const legReading = startupReading(cold.map((c) => ({ handlerMs: 2_000, beforeMs: c.before, cold: true, answer: { wait_total_ms: c.whole, wait_entry_at_ms: c.before - c.whole, loadtest_leg: "cold" } })), { leg: "cold" });
  const leg = coldAfterDeployText({ expected: 4, result, reading: legReading });
  assert(leg.includes(`by span isolate start p50 ${p.p50}ms, `), `the cold leg's spans lead with the isolate start (got: ${leg})`);
}

// --- #3410: the subrequest line states the mean it refers to ---------------------------
// It used to say "this run's mean per invocation is above" on every run, and no mean
// was printed anywhere above it, judged run or not (run 38833395446 among them). The
// mean is printed only where the judge itself read the window as this run's.
{
  const judged = { incomplete: false, platformUnmeasured: null };
  const reading = { invocations: 610, cpuMsP99: 40, subrequests: 52_000, statuses: { success: 610 }, cron: null };
  const measured = subrequestText(reading, judged);
  assert(measured.includes("85.2 subrequests per invocation"), `a judged window names its mean (got: ${measured})`);
  assert(measured.includes("52000 over 610 invocations"), `and the two figures it came from (got: ${measured})`);
  assert(!/is above/.test(measured), `and never points at a figure printed elsewhere (got: ${measured})`);
  // The judge's control: a count far under what the run made is a window that had not
  // caught up, so its numbers describe another window and no mean is claimed.
  const lagging = subrequestText({ ...reading, invocations: 12, subrequests: 900 }, { incomplete: false, platformUnmeasured: "the analytics API counted 12 invocations against the 610 this run made, so its CPU and subrequest numbers are about a different window" });
  assert(/not measured \(the analytics API counted 12 invocations/.test(lagging), `a window the judge called unmeasured claims no mean (got: ${lagging})`);
  assert(!/per invocation on average/.test(lagging), `even though both figures were read (got: ${lagging})`);
  const incomplete = subrequestText(reading, { incomplete: true, platformUnmeasured: null });
  assert(/the run was incomplete/.test(incomplete) && !/per invocation on average/.test(incomplete), `an incomplete run claims no mean either (got: ${incomplete})`);
  const unread = subrequestText({ invocations: null, cpuMsP99: null, subrequests: null, statuses: null, cron: null, unreadableWhy: "no Cloudflare credentials on this runner" }, judged);
  assert(/not measured \(no Cloudflare credentials on this runner\)/.test(unread), `an unread window says the mean was not measured, and why (got: ${unread})`);
  const none = subrequestText({ invocations: 0, cpuMsP99: null, subrequests: 0, statuses: {}, cron: null }, judged);
  assert(/no invocation was counted/.test(none), `a window with no invocation has no mean, said as such rather than 0 or NaN (got: ${none})`);
  for (const t of [measured, lagging, incomplete, unread, none]) assert(/1000 subrequest ceiling/.test(t), `every branch says why the mean is never a bar (got: ${t})`);
}

// --- #3354: the shared line's wait, split by the object's own log of its calls --------
{
  const base = startupReading([{ handlerMs: 900, beforeMs: 1_500, cold: true }])!;
  const none = lineSplitText(base);
  assert(/no confirm on the shared line carried a trace/.test(none), `a run with no traced confirm says the wait was not split, never a zero (got: ${none})`);
  assert(/not read/.test(lineSplitText(null)), "and a run with no archive says so");

  const split = (o: Partial<ReturnType<typeof emptySplit>>) => ({ ...emptySplit(), ...o });
  const text = lineSplitText({
    ...base,
    lineSplit: {
      cold: split({ traced: 3, joined: 2, missing: 1, heldMs: [700, 100], objectMs: [50, 30], outsideMs: [150, 400] }),
      warm: split({ traced: 4, joined: 4, impossible: 0, unreadable: 0, heldMs: [0, 0, 0, 10], objectMs: [15, 15, 15, 15], outsideMs: [85, 85, 90, 95] }),
      orphanCalls: 2,
      lineLog: "read",
      lineUnparsable: 0,
    },
  });
  assert(/cold 2 of 3 traced/.test(text), `the cold confirms joined, of those traced (got: ${text})`);
  // The expected figures come through the judge's own percentile, as the line's do (L41).
  const pp = (xs: number[]) => {
    const q = percentiles(xs)!;
    return `p50 ${q.p50}ms p95 ${q.p95}ms`;
  };
  assert(text.includes(`behind a leader ${pp([700, 100])}`), `with the time held behind a leader, through the judge's own percentile (got: ${text})`);
  assert(text.includes(`in the object ${pp([50, 30])}`), `the object's own work (got: ${text})`);
  assert(text.includes(`outside the object ${pp([150, 400])}`), `and the time outside the object (got: ${text})`);
  assert(/1 missing/.test(text), `a traced confirm whose calls never arrived is named, not dropped (got: ${text})`);
  assert(/warm 4 of 4 traced/.test(text), `and the warm side on its own (got: ${text})`);
  assert(/2 object calls matched no confirm/.test(text), `and calls whose confirm is not in the archive are counted (got: ${text})`);
  // #3815: where the line calls came from, and how many, is said on the line itself.
  const sourced = lineSplitText(base, "line calls read from the stored logs: 1812, where the live tail caught 470");
  assert(sourced.endsWith("; line calls read from the stored logs: 1812, where the live tail caught 470"), `the source and coverage close the line (got: ${sourced})`);
  assert(!/stored logs/.test(lineSplitText(base)), "and nothing is claimed when no source was given");

  // #3781: the object logs to its own Worker, so a run whose line Worker log was not
  // archived says that is why its confirms are missing, rather than a bare count.
  const absent = lineSplitText({ ...base, lineSplit: { cold: split({ traced: 2, missing: 2 }), warm: split({}), orphanCalls: 0, lineLog: "absent", lineUnparsable: 0 } });
  assert(/line Worker's own log \(line-tail\.jsonl\) was not archived/.test(absent), `a missing line log is named as the reason (got: ${absent})`);
  const read = lineSplitText({ ...base, lineSplit: { cold: split({ traced: 2, joined: 2, heldMs: [1, 2], objectMs: [1, 2], outsideMs: [1, 2] }), warm: split({}), orphanCalls: 0, lineLog: "read", lineUnparsable: 3 } });
  assert(!/not archived/.test(read), `a read line log is not called missing (got: ${read})`);
  assert(/3 lines of the line Worker's log not readable JSON/.test(read), `and its unreadable lines are counted (got: ${read})`);
  const empty = lineSplitText({ ...base, lineSplit: { cold: split({ traced: 2, missing: 2 }), warm: split({}), orphanCalls: 0, lineLog: "empty", lineUnparsable: 0 } });
  assert(/line Worker's own log \(line-tail\.jsonl\) was archived and held no invocation/.test(empty), `an empty line log is named as the reason (got: ${empty})`);
  // An archived file the judge could not read is not one that was never archived (L11).
  const unreadable = lineSplitText({ ...base, lineSplit: { cold: split({ traced: 2, missing: 2 }), warm: split({}), orphanCalls: 0, lineLog: "unreadable", lineUnparsable: 0 } });
  assert(/line Worker's own log \(line-tail\.jsonl\) was archived and could not be read/.test(unreadable), `an unreadable line log is named apart from an absent one (got: ${unreadable})`);
  assert(!/not archived/.test(unreadable), `and never called not archived (got: ${unreadable})`);
}

// --- #3354: the wait before the profile, by the version that served it and by leg -----
{
  const base = startupReading([{ handlerMs: 900, beforeMs: 1_500, cold: true }])!;
  const text = startupOriginText({
    ...base,
    byVersion: { "8fb6133b-c85f": { cold: [1_145, 2_782], warm: [200, 300], unknown: [] }, "5239f06d-aaaa": { cold: [1_500], warm: [], unknown: [] } },
    byLeg: { none: { cold: [900], warm: [], unknown: [] }, burst: { cold: [2_782], warm: [250], unknown: [] }, preflight: { cold: [1_145], warm: [], unknown: [] } },
  });
  assert(/8fb6133b cold n=2 max 2782ms, warm n=2 p95 300ms/.test(text), `each version's cold confirms and their slowest, beside its warm p95 (got: ${text})`);
  assert(/5239f06d cold n=1 max 1500ms, warm n=0/.test(text), `a version with no warm confirm says so rather than a zero (got: ${text})`);
  assert(text.indexOf("8fb6133b") < text.indexOf("5239f06d"), `the version with more confirms first (got: ${text})`);
  assert(text.indexOf("burst") < text.indexOf("preflight") && text.indexOf("preflight") < text.indexOf("none"), `legs in the run's own order, the unnamed last (got: ${text})`);
  assert(!/no index/.test(text), `a group with every index read says nothing about it (got: ${text})`);
  // #3418: a confirm with no invocation index is filed under its version and leg on
  // neither side, and counted there, so a group's total is never short in silence.
  const unknown = startupOriginText({ ...base, byVersion: { "8fb6133b-c85f": { cold: [], warm: [200], unknown: [700] } }, byLeg: {} });
  assert(/8fb6133b cold n=0, warm n=1 p95 200ms, no index n=1/.test(unknown), `a group's confirms with no index are counted (got: ${unknown})`);
  assert(/not read/.test(startupOriginText(null)), "and a run with no archive says so");
}

// --- #3354: the diagnostic cold leg, one confirm after each of N deploys --------------
{
  const attempt = (i: number, version: string | null, status: number | null) => ({
    i,
    slot: { code: "112", start: `s${i}` },
    deployOk: version !== null,
    version,
    sentAtMs: status === null ? null : 1_000 * i,
    status,
    outcome: status === 200 ? "created" : null,
  });
  assert(/not asked for/.test(coldAfterDeployText({ expected: 0, result: null, reading: null })), "a run that did not ask for the leg says so");
  // A value the judge cannot read started the job (the workflow stands down only on "0"
  // and ""), so it is never reported as not asked for (L11).
  const mistyped = coldAfterDeployText({ expected: 0, expectedUnreadable: 'cold_samples "abc" is not a whole number from 0 to 30', result: null, reading: null });
  assert(!/not asked for/.test(mistyped) && /cold_samples "abc"/.test(mistyped) && /nothing was measured/.test(mistyped), `an unreadable cold_samples is named, never read as not asked for (got: ${mistyped})`);
  const lost = coldAfterDeployText({ expected: 30, result: null, reading: null });
  assert(/asked for 30/.test(lost) && /never arrived/.test(lost), `a leg asked for whose results never arrived says so, never a zero (got: ${lost})`);

  const reading = startupReading([
    { handlerMs: 900, beforeMs: 1_800, cold: true, answer: { wait_route_ms: 1_000, wait_line_ms: 300, isolate_invocation_index: 0 } },
    { handlerMs: 900, beforeMs: 2_100, cold: true, answer: { wait_route_ms: 1_200, wait_line_ms: 350, isolate_invocation_index: 0 } },
    { handlerMs: 900, beforeMs: 600, cold: false, answer: { isolate_invocation_index: 3 } },
  ])!;
  // The cold leg's own confirms are the ones under its leg; a straggler from another
  // leg in the same tail window is in the archive and is not one of its samples.
  const withVersions = {
    ...reading,
    byVersion: { "aaaa1111-x": { cold: [1_800], warm: [], unknown: [] }, "bbbb2222-x": { cold: [2_100], warm: [600], unknown: [] } },
    byLeg: { cold: { cold: [1_800, 2_100], warm: [600], unknown: [] }, fault: { cold: [3_900], warm: [], unknown: [] } },
    // The archive as a whole also holds the straggler: four profiles, three of them cold.
    samples: 4,
    cold: 3,
    coldPreProfileMs: [1_800, 2_100, 3_900],
  };
  const result = {
    mode: "cold" as const,
    planned: 5,
    attempts: [attempt(1, "aaaa1111-x", 200), attempt(2, "bbbb2222-x", 200), attempt(3, null, null), attempt(4, "cccc3333-x", 200), attempt(5, "bbbb2222-x", 0)],
  };
  const text = coldAfterDeployText({ expected: 5, result, reading: withVersions });
  assert(/diagnostic, not a bar/.test(text), `it says it is not a bar (got: ${text})`);
  assert(/4 of 5 deploys made a version \(1 failed\)/.test(text), `how many deploys worked, and the failed one by name (got: ${text})`);
  assert(/3 confirms answered/.test(text), `and how many confirms got an answer, counted the way the leg counts them (got: ${text})`);
  // Sample 5 deployed bbbb2222 and got no answer: it served nothing, so it is not
  // counted as landing on its version, the same rule the leg's exit line uses.
  assert(/2 on the version just deployed/.test(text), `and how many landed on the version their deploy made, counting only answered confirms (got: ${text})`);
  assert(/the log read 3 of them/.test(text), `counting only the cold leg's own confirms in its log, not a straggler from another leg (got: ${text})`);
  assert(/2 of them their isolate's first request/.test(text), `and how many were their isolate's first request, said once (got: ${text})`);
  assert(!/Worker's first request/.test(text), `with no second count of the same thing beside it (got: ${text})`);
  assert(!text.includes("3900"), `a straggler's wait is not in the cold leg's figures (got: ${text})`);
  const p = percentiles([1_800, 2_100])!;
  assert(text.includes(`before the profile p50 ${p.p50}ms p95 ${p.p95}ms max ${p.max}ms`), `with the cold wait through the judge's own percentile (got: ${text})`);
  assert(/short of the 30 a startup change is judged against/.test(text), `and says a sample under the target is short of it (got: ${text})`);
  const unexpected = coldAfterDeployText({ expected: 0, result, reading: withVersions });
  assert(!/not asked for/.test(unexpected) && /4 of 5 deploys/.test(unexpected), `a leg whose results arrived is reported even when the run did not say it asked for one (got: ${unexpected})`);
  const corrupt = coldAfterDeployText({ expected: 5, result: null, unreadable: "Unexpected end of JSON input", reading: withVersions });
  assert(
    /results file could not be read \(Unexpected end of JSON input\)/.test(corrupt) && !/never arrived/.test(corrupt),
    `a results file that is there and unreadable is said apart from one that never arrived (got: ${corrupt})`,
  );
  const refusedLeg = coldAfterDeployText({ expected: 30, result: { mode: "cold", planned: 30, attempts: [], refused: "the offered times for code 212 could not be read (answered 429)" }, reading: null });
  assert(
    /refused before any deploy/.test(refusedLeg) && refusedLeg.includes("answered 429") && !/never arrived/.test(refusedLeg),
    `a leg that refused before deploying says so, with its reason (got: ${refusedLeg})`,
  );
  const unread = coldAfterDeployText({ expected: 5, result, reading: null });
  assert(/not archived|not read/.test(unread) && /3 confirms answered/.test(unread), `a leg whose log was not read says what it sent and that nothing was measured (got: ${unread})`);

  // Every figure on the line is the cold leg's own (L629): the first request count, the
  // span medians and the versions too, not only the waits. A straggler from another leg
  // in the tail window is left out of the reading itself, and the line says how many.
  const mixed = [
    { handlerMs: 900, beforeMs: 1_800, cold: true, answer: { wait_route_ms: 1_000, isolate_invocation_index: 0, loadtest_leg: "cold" } },
    { handlerMs: 900, beforeMs: 3_900, cold: true, answer: { wait_route_ms: 3_333, isolate_invocation_index: 0, loadtest_leg: "fault" } },
  ];
  const whole = startupReading(mixed)!;
  eq(whole.cold, 2, "control: read whole, the archive holds two first requests");
  const own = startupReading(mixed, { leg: "cold" })!;
  eq(own.cold, 1, "read for the cold leg, only its own confirm is a first request");
  eq(own.otherLegs, 1, "and the straggler is counted as left out, never dropped in silence");
  assert(!JSON.stringify(own.waitSpans).includes("3333"), `the straggler's spans are not in the reading (got ${JSON.stringify(own.waitSpans)})`);
  const one = { mode: "cold" as const, planned: 1, attempts: [attempt(1, "unknown", 200)] };
  const ownText = coldAfterDeployText({ expected: 1, result: one, reading: own });
  assert(/1 of them their isolate's first request/.test(ownText) && !ownText.includes("3333"), `the line carries the cold leg's own figures (got: ${ownText})`);
  // #3418: a cold leg confirm with no invocation index is on neither side and named, so
  // "the log read N" never counts it while "first request" silently does not.
  const noIndex = startupReading([{ handlerMs: 900, beforeMs: 1_800, cold: true, index: null, answer: { loadtest_leg: "cold" } }], { leg: "cold" })!;
  const noIndexText = coldAfterDeployText({ expected: 1, result: one, reading: noIndex });
  assert(/the log read 1 of them/.test(noIndexText) && /0 of them their isolate's first request/.test(noIndexText), `a confirm with no index is read and not counted first (got: ${noIndexText})`);
  assert(/1 with no invocation index/.test(noIndexText), `and is named (got: ${noIndexText})`);
  assert(/1 confirm from another leg left out/.test(ownText), `and says how many it left out (got: ${ownText})`);

  // A sample refused rather than booked still started on a fresh version, so it stays a
  // sample, but the line says how many were refused so a run of SLOT_TAKEN is visible.
  const refusedRun = { mode: "cold" as const, planned: 2, attempts: [attempt(1, "aaaa1111-x", 200), { ...attempt(2, "bbbb2222-x", 409), outcome: "SLOT_TAKEN" }] };
  const refusedText = coldAfterDeployText({ expected: 2, result: refusedRun, reading: withVersions });
  assert(/2 confirms answered \(1 refused rather than booked\)/.test(refusedText), `a refused confirm is named on the line (got: ${refusedText})`);
}

// =====================================================================================
// #3429: the refusal control, the tier drop burst, and the probe after each
// =====================================================================================
//
// Once a crowd walks the tier ladder (#3338, #3437), a SLOT_TAKEN is honest only when
// the ladder is really spent. After every burst each driver asks the deployment's own
// `/api/bookings/bookable` whether the slot is still bookable, which runs the routing a
// real book runs and is a reading no follower's SLOT_TAKEN consulted (L721). The judge
// holds each burst to the confirm crowd rule the deployment SAYS it runs, so a run on a
// build without #3437 is neither failed for #3338 nor passed by a bar that never asked.
// Every clause below is driven in both directions from a passing run (L1), and every
// outcome the contract names has a fixture that produces it (L151).

/**
 * A drop burst as the workflow fires it: four drivers of three requests on 120 and its
 * sibling, at leg 1 of the three leg run. `walks` books every confirm, the first on
 * 120's one advisor and the rest a rung down on distinct advisors; `stops` books the
 * top rung's advisor and refuses the rest, the way every build before #3437 answers.
 * The probe after it says the slot is still bookable a rung down, which it is under both
 * rules, because 130 holds the whole Low tier.
 */
function dropLeg(i: JudgeInput, outcome: "walks" | "stops", rule: string | undefined): void {
  const leg = 1;
  const replaced = new Set(i.burstResults.filter((r) => r.burstLeg?.index === leg).flatMap((r) => r.attempts.map((a) => a.externalId)));
  i.burstResults = i.burstResults.filter((r) => r.burstLeg?.index !== leg);
  const files = [0, 1, 2, 3].map((driver): DriverResult => {
    const attempts = Array.from({ length: 3 }, (_, k) => {
      const n = 75 + driver * 3 + k;
      const first = driver === 0 && k === 0;
      const won = outcome === "walks" || first;
      return attempt(driver, n, {
        code: burstCodeFor(SIBLINGS, driver, k),
        externalId: externalIdFor(idPrefix(RUN, "burst"), driver, n),
        startIso: LEG_SLOTS[leg]!,
        status: won ? 200 : 409,
        outcome: won ? "booked" : "SLOT_TAKEN",
        rungsDropped: won ? (first ? 0 : 1) : undefined,
        echo: echoOf({}, legAt(leg) + 800 + driver * 300 + k * 100),
      });
    });
    return {
      runId: RUN,
      driver,
      mode: "burst",
      planned: 3,
      startedAtMs: legAt(leg) - 1000,
      finishedAtMs: legAt(leg) + 4000,
      burstLeg: {
        index: leg,
        of: 3,
        slot: LEG_SLOTS[leg]!,
        codes: [...SIBLINGS],
        startAtMs: legAt(leg),
        kind: "drop",
        capacity: { ladderRoster: 74, rung0Free: 1, ladderFree: 40 },
      },
      crowdRule: crowdRuleOf(rule),
      probe: probeOf(burstCodeFor(SIBLINGS, driver, 0), legAt(leg), { bookable: true, reason: "available", rungsDropped: 1, effective: "130" }),
      attempts,
    };
  });
  i.burstResults.push(...files);
  const winners = files.flatMap((f) => f.attempts.filter((a) => a.status === 200));
  i.bookings = [
    ...i.bookings.filter((b) => !replaced.has(b.external_id ?? "")),
    ...winners.map((a, k) => bookingFor(a, { assigned_user_id: k === 0 ? "agent-beyond-low" : `agent-low-${k}` })),
  ];
  i.bookingIdsWithBusyBlock = i.bookings.map((b) => b.id);
}

function withDrop(outcome: "walks" | "stops", rule: string | undefined, mutate: (i: JudgeInput) => void = () => {}) {
  const input = threeBursts();
  dropLeg(input, outcome, rule);
  mutate(input);
  return judgeBookingRun(input);
}

// --- the drop burst on a build that walks the ladder ---------------------------------
{
  const r = withDrop("walks", "walks");
  eq(`${r.verdict} ${bars(r).join("|")}`, "pass ", "a drop burst where every confirm wins, a rung down on distinct advisors, passes");
  const leg = r.measurements!.bursts[1]!;
  eq(leg.kind, "drop", "and is read as the drop burst");
  eq(leg.won, 12, "every one of its twelve won");
  eq(leg.dropped, 11, "eleven of them a rung below the one asked for");
  const text = burstLegText(leg);
  assert(text.includes("tier drop burst") && text.includes("11 below the requested rung"), `its line names the kind and the drop (got: ${text})`);
  assert(!r.findings.some((f) => f.bar === "the burst's speed"), "and a drop burst is never asked the loser speed question: it has no losers");
}

{
  // #3338 itself: the crowd stops at the top rung's last advisor and every other
  // confirm is told the slot is taken while a rung below is free. On a deployment
  // that says it walks, that FAILS by name.
  const r = withDrop("stops", "walks");
  const f = r.findings.find((x) => x.bar === "the burst's refusals");
  assert(f !== undefined, "eleven SLOT_TAKEN while the slot still answers available fail on a build that says it walks");
  assert(
    f !== undefined && f.detail.includes("burst 2 of 3") && f.detail.includes("#3338") && f.detail.includes("1 rung down") && f.detail.includes("130"),
    `naming the burst, the issue, and where the slot was still free (got: ${f?.detail})`,
  );
  eq(r.verdict, "fail", "and the run fails");
  eq(r.burstsUnconcluded, [], "with that one finding, not a second unconcluded clause about the same refusals");
}

{
  // The SAME outcome on a deployment that says it stops at the rung (the rule before
  // #3437) is the defect that build declares: expected, named, and not a failure.
  const r = withDrop("stops", "stops");
  eq(`${r.verdict} ${bars(r).join("|")}`, "pass ", "the old build's known defect does not fail the run");
  const leg = r.measurements!.bursts[1]!;
  assert(leg.notes.some((n) => n.includes("#3338") && n.includes("stops")), `and the burst says it saw #3338 on a build that declares it (got: ${JSON.stringify(leg.notes)})`);
  const summary = burstsSummaryText(r.measurements!.bursts)!;
  assert(summary.includes("#3338") && summary.includes("burst 2 of 3"), `so the summary never reads as a silent pass (got: ${summary})`);
  const verdict = verdictText(r);
  assert(
    verdict.includes("PASS") && verdict.includes("#3338") && verdict.includes("stops at its rung"),
    `and nor does the verdict line itself, which names the rule it held the run to (got: ${verdict})`,
  );
  // Control: a run on a walks build whose bursts all passed claims no known defect.
  assert(!verdictText(withDrop("walks", "walks")).includes("#3338"), "control: a clean walks run's verdict names no defect");
}

{
  // A build that says it stops but whose drop burst every confirm won could not show
  // the defect it declares: the declaration is wrong or the crowd never contended.
  // Learning nothing is never a pass (L98).
  const r = withDrop("walks", "stops");
  eq(r.verdict, "inconclusive", "a stops build whose drop burst all won cannot conclude");
  eq(r.exit, JUDGE_EXIT.inconclusive, "on the inconclusive exit");
  assert(r.measurements !== null, "with every figure still measured, because only the burst could not conclude");
  const u = r.burstsUnconcluded.find((x) => x.bar === "the tier drop");
  assert(u !== undefined && u.detail.includes("could not show the defect"), `saying why (got: ${u?.detail})`);
}

{
  // A deployment that never said which rule it runs leaves the drop burst nothing to be
  // held to, whatever happened.
  for (const rule of [undefined, "Walks"]) {
    const r = withDrop("walks", rule);
    eq(r.verdict, "inconclusive", `a drop burst under ${rule === undefined ? "no declared rule" : "a rule nobody knows"} cannot conclude`);
    const u = r.burstsUnconcluded.find((x) => x.bar === "the tier drop");
    assert(u !== undefined && u.detail.includes("cannot be held to either rule"), `saying so (got: ${u?.detail})`);
  }
  // Control: a refusal control whose refusals were honest needs no rule at all.
  const r = brokenThree((i) => {
    for (const f of i.burstResults) f.crowdRule = crowdRuleOf(undefined);
  });
  eq(r.verdict, "pass", "control: honest refusals pass whatever the deployment declares");
}

{
  // #3459 review (L11): only a probe that says the slot is TAKEN proves the SLOT_TAKEN
  // answers honest. A slot not bookable for another reason (the business day closed, no
  // eligible advisor, which is the booker's own routing failing) says nothing about
  // whether the line refused leads it could have booked, so the refusals bar cannot
  // conclude, and says which reason it saw rather than passing.
  for (const reason of ["closed", "no_eligible_agents"]) {
    const r = brokenThree((i) => {
      for (const f of i.burstResults) f.probe = probeOf(f.burstLeg?.codes[0] ?? "120", legAt(f.burstLeg?.index ?? 0), { bookable: false, reason });
    });
    eq(r.verdict, "inconclusive", `refusal honesty, ${reason}: a probe that is not "taken" cannot prove the refusals honest`);
    const u = r.burstsUnconcluded.find((x) => x.bar === "the burst's refusals");
    assert(u !== undefined && u.detail.includes(reason), `refusal honesty, ${reason}: and the reason is named (got: ${u?.detail})`);
  }
  // Control (L159): the same burst with the slot honestly taken passes.
  const taken = brokenThree((i) => {
    for (const f of i.burstResults) f.probe = probeOf(f.burstLeg?.codes[0] ?? "120", legAt(f.burstLeg?.index ?? 0), { bookable: false, reason: "slot_taken" });
  });
  eq(taken.verdict, "pass", "refusal honesty, control: a probe that says taken still passes");
}

{
  // The crowd outran what the ladder held: SLOT_TAKEN, and the slot honestly taken.
  // That is not #3338 and not a pass: the drop could not be shown.
  const r = withDrop("stops", "walks", (i) => {
    for (const f of i.burstResults.filter((x) => x.burstLeg?.index === 1)) {
      f.probe = probeOf("120", legAt(1), { bookable: false, reason: "slot_taken" });
    }
  });
  eq(r.verdict, "inconclusive", "a drop burst refused by a really spent ladder cannot conclude");
  assert(!r.findings.some((x) => x.bar === "the burst's refusals"), "and accuses nobody, since every refusal was honest");
  const u = r.burstsUnconcluded.find((x) => x.bar === "the tier drop");
  assert(u !== undefined && u.detail.includes("outran"), `saying the crowd outran the ladder (got: ${u?.detail})`);
}

{
  // #3459 review (L11): a drop burst whose slot answered something other than taken is
  // the refusals bar's to leave open; the tier drop bar must not claim the crowd outran
  // the ladder, which only a taken slot shows.
  const r = withDrop("stops", "walks", (i) => {
    for (const f of i.burstResults.filter((x) => x.burstLeg?.index === 1)) {
      f.probe = probeOf("120", legAt(1), { bookable: false, reason: "no_eligible_agents" });
    }
  });
  eq(r.verdict, "inconclusive", "a drop burst whose slot answered no eligible advisor cannot conclude");
  assert(
    r.burstsUnconcluded.some((x) => x.bar === "the burst's refusals" && x.detail.includes("no_eligible_agents")),
    "and the refusals bar says why",
  );
  assert(
    !r.burstsUnconcluded.some((x) => x.bar === "the tier drop" && x.detail.includes("outran")),
    `and the tier drop bar does not claim the crowd outran the ladder (got: ${r.burstsUnconcluded.map((x) => x.detail).join(" | ")})`,
  );
}

{
  // #3459 lessons review (L260): the same probe on a build that says it STOPS. The
  // refusals bar has already been left open for it, so the tier drop bar must not list
  // it a second time as a burst that could not show the declared defect, blaming the
  // crowd or the declaration for what is one unknown about the slot.
  for (const reason of ["closed", "no_eligible_agents"]) {
    const r = withDrop("stops", "stops", (i) => {
      for (const f of i.burstResults.filter((x) => x.burstLeg?.index === 1)) {
        f.probe = probeOf("120", legAt(1), { bookable: false, reason });
      }
    });
    eq(r.verdict, "inconclusive", `stops build, ${reason}: a drop burst whose slot answered ${reason} cannot conclude`);
    assert(
      r.burstsUnconcluded.some((x) => x.bar === "the burst's refusals" && x.detail.includes(reason)),
      `stops build, ${reason}: the refusals bar says why`,
    );
    assert(
      !r.burstsUnconcluded.some((x) => x.bar === "the tier drop"),
      `stops build, ${reason}: and the tier drop bar does not report the same unknown again (got: ${r.burstsUnconcluded.map((x) => `${x.bar}: ${x.detail}`).join(" | ")})`,
    );
  }
}

{
  // #3459 review: on a build that says it stops, a drop burst whose losers were told
  // SLOT_TAKEN while the REQUESTED rung was still free has already failed the refusals
  // bar, on any build. The tier drop bar must not ALSO list it as a burst that could
  // not show the declared defect: that would report one fault twice, the second time
  // blaming the crowd or the declaration for it.
  const r = withDrop("stops", "stops", (i) => {
    for (const f of i.burstResults.filter((x) => x.burstLeg?.index === 1)) {
      f.probe = probeOf("120", legAt(1), { bookable: true, reason: "available", rungsDropped: 0 });
    }
  });
  const refused = r.findings.filter((x) => x.bar === "the burst's refusals" && x.detail.includes("burst 2 of 3"));
  eq(refused.length, 1, "the requested rung refusal fails the drop burst once, on the refusals bar");
  assert(refused[0]!.detail.includes("requested rung itself"), `naming the requested rung (got: ${refused[0]?.detail})`);
  eq(
    r.burstsUnconcluded.filter((x) => x.detail.includes("burst 2 of 3")),
    [],
    "and the tier drop bar does not report the same refusals again as a burst that could not conclude",
  );
  // Control (L159): with the slot honestly taken, the same stops drop burst still
  // cannot show the declared defect, so the tier drop bar is still asked.
  const spent = withDrop("stops", "stops", (i) => {
    for (const f of i.burstResults.filter((x) => x.burstLeg?.index === 1)) {
      f.probe = probeOf("120", legAt(1), { bookable: false, reason: "slot_taken" });
    }
  });
  assert(
    spent.burstsUnconcluded.some((x) => x.bar === "the tier drop" && x.detail.includes("burst 2 of 3")),
    "control: a stops drop burst whose slot was honestly spent still cannot conclude",
  );
}

{
  // Every confirm won, and none says it landed below the top rung: the burst never
  // showed a tier being dropped, so it proved nothing about #3338.
  const r = withDrop("walks", "walks", (i) => {
    for (const f of i.burstResults.filter((x) => x.burstLeg?.index === 1)) for (const a of f.attempts) a.rungsDropped = 0;
  });
  eq(r.verdict, "inconclusive", "a drop burst that never dropped cannot conclude");
  const u = r.burstsUnconcluded.find((x) => x.bar === "the tier drop");
  assert(u !== undefined && u.detail.includes("never showed a tier being dropped"), `saying so (got: ${u?.detail})`);
  const unsaid = withDrop("walks", "walks", (i) => {
    for (const f of i.burstResults.filter((x) => x.burstLeg?.index === 1)) for (const a of f.attempts) delete a.rungsDropped;
  });
  const v = unsaid.burstsUnconcluded.find((x) => x.bar === "the tier drop");
  assert(v !== undefined && v.detail.includes("did not say which rung"), `an answer that never said which rung is never read as dropped (got: ${v?.detail})`);
}

{
  // A confirm the line could not serve inside its wait is a retryable 503, never a
  // win: on a crowd of twelve that is a finding about the line, by the losers bar.
  const r = withDrop("walks", "walks", (i) => {
    const a = i.burstResults.find((x) => x.burstLeg?.index === 1 && x.driver === 3)!.attempts[2]!;
    a.status = 503;
    a.outcome = "VERIFY_UNAVAILABLE";
    delete a.rungsDropped;
    i.bookings = i.bookings.filter((b) => b.external_id !== a.externalId);
  });
  assert(
    r.findings.some((x) => x.bar === "the burst's losers" && x.detail.includes("burst 2 of 3") && x.detail.includes("503 VERIFY_UNAVAILABLE")),
    "a drop burst confirm answered 503 fails, naming it",
  );
  const doubled = withDrop("walks", "walks", (i) => {
    const winners = i.burstResults.filter((x) => x.burstLeg?.index === 1).flatMap((x) => x.attempts);
    const second = i.bookings.find((b) => b.external_id === winners[5]!.externalId)!;
    second.assigned_user_id = i.bookings.find((b) => b.external_id === winners[4]!.externalId)!.assigned_user_id;
  });
  assert(
    doubled.findings.some((x) => x.bar === "the burst's winners" && x.detail.includes("burst 2 of 3")),
    "two drop burst winners on one advisor fail as a double booking",
  );
}

// --- the refusal control, held to the same rule -------------------------------------
{
  const availableBelow = (rule: string) =>
    brokenThree((i) => {
      for (const f of i.burstResults.filter((x) => x.burstLeg?.index === 2)) {
        f.crowdRule = crowdRuleOf(rule);
        f.probe = probeOf("120", legAt(2), { bookable: true, reason: "available", rungsDropped: 1, effective: "130" });
      }
    });
  const walks = availableBelow("walks");
  assert(
    walks.findings.some((x) => x.bar === "the burst's refusals" && x.detail.includes("burst 3 of 3") && x.detail.includes("#3338")),
    "a refusal control refused while a rung below is free fails on a walks build",
  );
  const stops = availableBelow("stops");
  eq(stops.verdict, "pass", "and is the declared, expected defect on a stops build");
  assert(stops.measurements!.bursts[2]!.notes.length === 1, "named on that burst");

  // A slot still bookable on the REQUESTED rung itself is not #3338's shape: the line
  // refused leads its own rung could take. That fails on any build.
  const sameRung = brokenThree((i) => {
    for (const f of i.burstResults.filter((x) => x.burstLeg?.index === 0)) {
      f.crowdRule = crowdRuleOf("stops");
      f.probe = probeOf("120", legAt(0), { bookable: true, reason: "available", rungsDropped: 0 });
    }
  });
  const f = sameRung.findings.find((x) => x.bar === "the burst's refusals");
  assert(
    f !== undefined && f.detail.includes("burst 1 of 3") && f.detail.includes("requested rung itself") && f.detail.includes("any build"),
    `refusals while the requested rung is still free fail even on a stops build (got: ${f?.detail})`,
  );

  // And with no declared rule, a slot free a rung down cannot be judged either way.
  const unknown = brokenThree((i) => {
    for (const x of i.burstResults.filter((y) => y.burstLeg?.index === 0)) {
      x.crowdRule = crowdRuleOf(undefined);
      x.probe = probeOf("120", legAt(0), { bookable: true, reason: "available", rungsDropped: 2, effective: "110" });
    }
  });
  eq(unknown.verdict, "inconclusive", "a rung below free under an undeclared rule cannot conclude");
  assert(unknown.burstsUnconcluded.some((x) => x.bar === "the burst's refusals" && x.detail.includes("2 rungs down")), "saying where the slot was free");
}

// --- the probe itself: unreadable, early, or contradictory is never a pass ---------
{
  const unreadable = brokenThree((i) => {
    for (const f of i.burstResults.filter((x) => x.burstLeg?.index === 0)) {
      f.probe = readBurstProbe({ code: "120", sentAtMs: burstSettleAtMs(legAt(0), BURST_GRACE_DEFAULT_MS, REQUEST_TIMEOUT_MS) + 5, status: 503, body: { code: "VERIFY_UNAVAILABLE" } });
    }
  });
  eq(unreadable.verdict, "inconclusive", "a burst whose every probe was refused cannot say its refusals were honest");
  const u = unreadable.burstsUnconcluded.find((x) => x.bar === "the burst's refusals");
  assert(u !== undefined && u.detail.includes("burst 1 of 3") && u.detail.includes("503 VERIFY_UNAVAILABLE"), `naming the probe's own answer (got: ${u?.detail})`);

  const missing = brokenThree((i) => {
    for (const f of i.burstResults.filter((x) => x.burstLeg?.index === 0)) delete f.probe;
  });
  assert(missing.burstsUnconcluded.some((x) => x.detail.includes("not recorded")), "a probe never recorded is unconcluded, never read as taken");

  // #3459 review: a run whose every figure was MEASURED and whose burst could not
  // conclude has its own verdict and exit code. INCOMPLETE (exit 2) means the run did
  // not happen as asked and nothing was measured; reading the two alike on one code
  // would send a reader to re-run a run that ran.
  eq(missing.verdict, "inconclusive", "a measured run whose burst could not conclude is inconclusive");
  eq(missing.exit, JUDGE_EXIT.inconclusive, "on its own exit code");
  assert(missing.measurements !== null, "with every figure measured");
  assert(JUDGE_EXIT.inconclusive !== JUDGE_EXIT.incomplete, "and that code is not the code of a run that did not happen as asked");
  eq(new Set(Object.values(JUDGE_EXIT)).size, Object.keys(JUDGE_EXIT).length, "every way the judge ends has a code of its own");
  const notRun = brokenThree((i) => i.driverResults.pop());
  eq(`${notRun.verdict} ${notRun.exit}`, `incomplete ${JUDGE_EXIT.incomplete}`, "control: a run missing a driver file is still incomplete on exit 2");

  // #3459 review (L46): until #3446 lands, no driver writes the crowd rule, the probe,
  // the burst's kind or capacity, or a winner's rung. A run whose burst files carry
  // NONE of them, as main's drivers write them today, must read as not measured and
  // never as a pass.
  const unwired = brokenThree((i) => {
    for (const f of i.burstResults) {
      delete f.crowdRule;
      delete f.probe;
      if (f.burstLeg) {
        delete f.burstLeg.kind;
        delete f.burstLeg.capacity;
      }
      for (const a of f.attempts) delete a.rungsDropped;
    }
  });
  eq(unwired.verdict, "inconclusive", "burst files written before #3429 are never a pass");
  eq(
    unwired.burstsUnconcluded.filter((x) => x.bar === "the burst's refusals" && x.detail.includes("not recorded")).length,
    3,
    "every burst's refusals left open, for a probe never recorded",
  );
  assert(
    unwired.measurements!.bursts.every((b) => burstLegText(b).includes("capacity was not recorded")),
    "and every burst's line says its capacity was not recorded, never a number",
  );

  // #3459 review: the platform half's early returns hold the SAME precedence as the
  // end of the judge, where a burst that could not conclude outranks a void reading.
  // An unreadable platform half used to answer UNMEASURED over it, so the run's exit
  // named the analytics and not the burst that never proved what it exists to prove.
  const blind = brokenThree((i) => {
    for (const f of i.burstResults.filter((x) => x.burstLeg?.index === 0)) delete f.probe;
    i.platform = { invocations: null, cpuMsP99: null, subrequests: null, statuses: null, cron: null };
  });
  eq(blind.verdict, "inconclusive", "an unconcluded burst on a run whose platform half is unreadable is inconclusive");
  eq(blind.exit, JUDGE_EXIT.inconclusive, "on the inconclusive exit code");
  assert(blind.burstsUnconcluded.some((x) => x.detail.includes("not recorded")), "naming the burst clause");
  assert(blind.platformUnmeasured !== null, "with the unreadable platform half still reported beside it");
  assert(blind.findings.some((f) => f.bar === "platform limits"), "and its finding kept");
  // The other direction (L159): a measured failure still outranks both.
  const blindAndFailed = brokenThree((i) => {
    for (const f of i.burstResults.filter((x) => x.burstLeg?.index === 0)) delete f.probe;
    i.platform = { invocations: null, cpuMsP99: null, subrequests: null, statuses: null, cron: null };
    i.faultPass = { attempts: 30, availabilityUnread: 0, fiveXx: 3, faultPct: 10, faultTargets: ["google-read"] };
  });
  eq(blindAndFailed.verdict, "fail", "and a measured failure beside them still fails the run");

  // #3459 review: the settle is the latest any driver of the burst could have fired
  // plus a request's bound, on the grace and bound the drivers RECORD, never a
  // driver's own word about its settle. A hand run with a shorter grace probes sooner,
  // and those probes are not early; a longer grace probes later, and a probe sent at
  // the default settle would be.
  const shortGrace = 500;
  const shorter = brokenThree((i) => {
    for (const f of i.burstResults.filter((x) => x.burstLeg?.index === 0)) {
      f.burstLeg!.graceMs = shortGrace;
      f.probe = readBurstProbe({
        code: "120",
        sentAtMs: burstSettleAtMs(legAt(0), shortGrace, REQUEST_TIMEOUT_MS) + 5,
        status: 200,
        body: { bookable: false, reason: "slot_taken", requestedBucketCode: "120", effectiveBucketCode: null, tierFallback: false, rungsDropped: 0 },
      });
    }
  });
  assert(
    !shorter.burstsUnconcluded.some((x) => x.detail.includes("burst 1 of 3")),
    `a probe sent after the settle of the grace the drivers recorded is used (got: ${JSON.stringify(shorter.burstsUnconcluded)})`,
  );
  const longer = brokenThree((i) => {
    for (const f of i.burstResults.filter((x) => x.burstLeg?.index === 0)) f.burstLeg!.graceMs = 10_000;
  });
  assert(
    longer.burstsUnconcluded.some((x) => x.detail.includes("burst 1 of 3") && x.detail.includes("before the burst settled")),
    "and a probe sent at the default settle of a burst whose drivers recorded a longer grace is early",
  );
  const mixed = brokenThree((i) => {
    const files = i.burstResults.filter((x) => x.burstLeg?.index === 0);
    files[0]!.burstLeg!.graceMs = 10_000;
  });
  assert(
    mixed.burstsUnconcluded.some((x) => x.detail.includes("burst 1 of 3") && x.detail.includes("before the burst settled")),
    "the longest grace any driver of the burst recorded decides, since that driver may have fired last",
  );
  const unreadableGrace = brokenThree((i) => {
    for (const f of i.burstResults.filter((x) => x.burstLeg?.index === 0)) f.burstLeg!.requestBoundMs = -1;
  });
  assert(
    unreadableGrace.burstsUnconcluded.some((x) => x.detail.includes("burst 1 of 3") && x.detail.includes("request bound")),
    `a recorded bound that is not a whole number of milliseconds leaves the settle unknown, by name (got: ${JSON.stringify(unreadableGrace.burstsUnconcluded)})`,
  );

  const early = brokenThree((i) => {
    for (const f of i.burstResults.filter((x) => x.burstLeg?.index === 0)) {
      f.probe = probeOf("120", legAt(0), { bookable: false, reason: "slot_taken" }, -5_000);
    }
  });
  assert(early.burstsUnconcluded.some((x) => x.detail.includes("before the burst settled")), "a probe sent while confirms could still be walking proves nothing");

  const split = brokenThree((i) => {
    const files = i.burstResults.filter((x) => x.burstLeg?.index === 0);
    files[0]!.probe = probeOf("120", legAt(0), { bookable: true, reason: "available", rungsDropped: 1, effective: "130" });
  });
  assert(split.burstsUnconcluded.some((x) => x.detail.includes("disagree")), "probes that disagree conclude nothing rather than one being picked");

  // A readable probe beside an unreadable one still concludes.
  const partial = brokenThree((i) => {
    const files = i.burstResults.filter((x) => x.burstLeg?.index === 0);
    delete files[0]!.probe;
  });
  eq(partial.verdict, "pass", "one probe lost among four does not stop the others concluding");
}

// --- what the run's verdict says when a burst could not conclude ---------------------
{
  // A real finding elsewhere outranks a burst that could not conclude: the run FAILS.
  const both = withDrop("walks", undefined, (i) => {
    i.slotUniqueIndexPresent = false;
  });
  eq(both.verdict, "fail", "a finding and an unconcluded burst together fail the run");
  assert(both.burstsUnconcluded.length > 0, "and the unconcluded burst is still carried for the report");

  const alone = withDrop("walks", undefined);
  const text = verdictText(alone);
  assert(
    text.includes("INCONCLUSIVE") && text.includes("could not conclude"),
    `an otherwise clean run whose burst could not conclude says so on the verdict line (got: ${text})`,
  );
  const summary = burstsSummaryText(alone.measurements!.bursts)!;
  assert(summary.includes("could not conclude") && summary.includes("burst 2 of 3"), `and the burst summary names it (got: ${summary})`);
  // Control: the clean three leg run's verdict line claims nothing unconcluded.
  assert(!verdictText(judgeBookingRun(threeBursts())).includes("could not conclude"), "control: a clean run's verdict line says nothing of it");
}

// --- the report line carries what was measured about each burst ----------------------
{
  const r = withDrop("walks", "walks");
  const drop = burstLegText(r.measurements!.bursts[1]!);
  assert(drop.includes("74") && drop.includes("40 were free"), `the drop burst's line carries its measured capacity (got: ${drop})`);
  assert(drop.includes("available 1 rung down (130)"), `and what the slot answered after it (got: ${drop})`);
  assert(drop.includes("walks the tier ladder"), `and the rule the deployment declared (got: ${drop})`);
  assert(drop.includes("no losers to time") && drop.includes("answered across"), `and how long its winners took instead of a loser bar (got: ${drop})`);
  const refusal = burstLegText(r.measurements!.bursts[0]!);
  assert(refusal.includes("refusal control") && refusal.includes("answered slot_taken"), `a refusal control's line says the slot was spent (got: ${refusal})`);
  assert(refusal.includes("capacity was not recorded"), `and, from a file written before #3429, that its capacity was not recorded (got: ${refusal})`);
}


// --- #3566: a request resent after a dropped connection, and the cap on them -----------
// The driver sends a request whose connection dropped once more, as the booker does for a
// lead. One answered on its resend is not unanswered; but a cluster of them means
// something is turning connections away, so 3 or more in a run fail it (Dan, 2026-10-14),
// counted over every request the judge reads, the bursts' included.
{
  const resend = (a: BookingAttempt) => {
    a.resentAfter = "transport: TypeError (UND_ERR_SOCKET)";
  };
  eq(RESENT_FAIL_AT, 3, "the cap Dan chose: a run fails at 3 resent requests");

  const clean = judgeBookingRun(passing());
  eq(clean.measurements!.resent, 0, "a run with no resend measures zero");
  assert(resentText(clean.measurements!).includes("0 requests"), `and says so on its own line (got: ${resentText(clean.measurements!)})`);

  const two = broken((i) => {
    resend(i.driverResults[0]!.attempts[0]!);
    resend(i.driverResults[1]!.attempts[0]!);
  });
  eq(two.measurements!.resent, 2, "two resent requests are counted");
  assert(!bars(two).includes("resent requests"), `two is under the cap, so it passes (got ${JSON.stringify(bars(two))})`);
  assert(!bars(two).includes("unanswered requests"), "and a request answered on its resend is not unanswered");
  const line = resentText(two.measurements!);
  assert(line.includes("2 requests") && line.includes("UND_ERR_SOCKET"), `the line counts them and names why (got: ${line})`);

  const three = broken((i) => {
    for (const d of [0, 1, 2]) resend(i.driverResults[d]!.attempts[0]!);
  });
  assert(bars(three).includes("resent requests"), `three resent requests fail the run (got ${JSON.stringify(bars(three))})`);

  // Still unanswered after its resend: both the unanswered bar AND counted as resent.
  const silent = broken((i) => {
    const a = i.driverResults[0]!.attempts[0]!;
    a.status = 0;
    a.outcome = "transport: TypeError";
    resend(a);
    i.bookings = i.bookings.filter((b) => b.external_id !== `${RUN}-0-0`);
    i.bookingIdsWithBusyBlock = i.bookings.map((b) => b.id);
  });
  assert(bars(silent).includes("unanswered requests"), "a request still unanswered after its resend fails as unanswered");
  eq(silent.measurements!.resent, 1, "and is counted as resent");

  // The bursts' requests count toward the same cap.
  const withBurst = brokenThree((i) => {
    resend(i.driverResults[0]!.attempts[0]!);
    resend(i.driverResults[1]!.attempts[0]!);
    resend(legAttempts(i, 0)[0]!);
  });
  eq(withBurst.measurements!.resent, 3, "a burst request's resend is counted with the steady ones");
  assert(bars(withBurst).includes("resent requests"), "so two steady and one burst resend fail the run");
}

finish();
