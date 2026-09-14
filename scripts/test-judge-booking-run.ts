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
  percentiles,
  overlaps,
  JUDGE_EXIT,
  OK_P95_MS,
  FRESHNESS_MAX_SEC,
  type JudgeInput,
  type JudgedBooking,
} from "./loadtest/judge-booking-run.ts";
import type { BookingAttempt, DriverResult } from "./loadtest/book-plan.ts";
import { REQUEST_CPU_P99_MS, REQUEST_STARTUP_P95_MS } from "./loadtest/judge-booking-run.ts";
import {
  ceilingVerdict,
  exactAddressBound,
  CEILING_REFUSED_BY,
  type CeilingAttempt,
} from "./loadtest/preflight-checks.ts";
import { DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES } from "../src/lib/rate-limit-core.ts";
import { readConfirmStartup } from "./loadtest/confirm-startup.ts";
import { formatLine } from "../src/lib/log.ts";

/**
 * A confirm startup reading built by the REAL reader from REAL shaped tail lines,
 * so no fixture here can describe a state the reader cannot produce (L48).
 *
 * `cold` is the wall time before the confirm began on an isolate that became ready
 * inside that request, and `warm` the same on one that did not. The reader decides
 * which is which from the isolate's age; these just supply ages that make it so.
 */
function startupReading(
  rows: { handlerMs: number; beforeMs: number; cold: boolean; afterMs?: number }[],
) {
  const lines = rows.map((r) =>
    JSON.stringify({
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
              isolate_age_ms: r.cold ? Math.max(0, r.beforeMs - 1) : r.beforeMs + 1,
            }),
          ],
        },
      ],
    }, null, 4),
  );
  return readConfirmStartup(lines.join("\n"));
}

/** The app's own exact per address bound, so these fixtures cannot describe a
 *  state the control can never produce (L48). */
const CEILING_EXACT_BOUND = exactAddressBound(DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES)!;
import { assert, eq, finish } from "./lib/harness.ts";

const RUN = "run-1";
const T0 = Date.parse("2026-09-15T14:00:00.000Z");
const TARGET = { drivers: 4, perDriverPerMinute: 15, minutes: 10 };
const PER_DRIVER = TARGET.perDriverPerMinute * TARGET.minutes;

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
  const burstWinner = attempt(9, 0, { code: "122", startIso: "2026-09-16T15:00:00.000Z" });
  const burstResults: DriverResult[] = [
    {
      runId: RUN,
      driver: 9,
      mode: "burst",
      planned: 25,
      startedAtMs: T0,
      finishedAtMs: T0 + 2000,
      attempts: [
        burstWinner,
        ...Array.from({ length: 24 }, (_, i) =>
          attempt(9, i + 1, {
            code: "122",
            startIso: "2026-09-16T15:00:00.000Z",
            status: 409,
            outcome: "SLOT_TAKEN",
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
      cron: { invocations: 0, worstCpuMs: 0, byCron: {} },
    },
    faultPass: { attempts: 100, fiveXx: 0, faultPct: 10 },
    expectedLegs: { burstDrivers: burstResults.length, faultPct: 10 },
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

  // A burst driver that missed its moment is INCOMPLETE rather than failed: it
  // recorded nothing, so there is no contention to judge and "exactly one 200"
  // would be answered by however many drivers happened to arrive.
  const missed = broken((i) => {
    i.burstResults[0]!.burstSkipped = "missed";
    i.burstResults[0]!.attempts = [];
  });
  eq(missed.verdict, "incomplete", "a burst driver that did not fire makes the burst unjudgeable");
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
    i.driverResults[0]!.attempts[0]!.outcome = "no-slots-offered";
    i.bookings = i.bookings.filter((b) => b.external_id !== `${RUN}-0-0`);
    i.bookingIdsWithBusyBlock = i.bookings.map((b) => b.id);
  });
  assert(
    !bars(noSlots).includes("unanswered requests"),
    "a bucket that offered nothing is not an unanswered request",
  );
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

  const noBurst = broken((i) => {
    i.burstResults = [];
  });
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
    `a cold start over the ${REQUEST_STARTUP_P95_MS}ms left of the latency bar is a finding`,
  );
  const slowDetail = slow.findings.find((f) => f.bar === "confirm startup")!.detail;
  assert(/cold isolate/.test(slowDetail), "and the detail says what a lead actually met");
  assert(
    /warm/.test(slowDetail),
    "beside the warm number, because the gap between the two is the whole reading",
  );

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
  const three = new Set(
    [empty, noCold, broken((i) => { i.confirmStartup = null; })].map(
      (r) => r.findings.find((f) => f.bar === "confirm startup")!.detail,
    ),
  );
  eq(three.size, 3, "and no two of the three share a sentence");
}

// --- the CPU finding says which half moved -------------------------------------------
{
  // The reading that would otherwise send somebody to optimise the confirm while
  // the seconds are being spent before it starts.
  const cpu = broken((i) => {
    i.platform = { ...i.platform, cpuMsP99: 2_988 };
  });
  const cpuDetail = cpu.findings.find((f) => f.bar === "Worker CPU on the request path")!.detail;
  assert(/first on their isolate/.test(cpuDetail), "the CPU finding names how many were cold starts");
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
    i.faultPass = { attempts: 100, fiveXx: 4, faultPct: 10 };
  });
  assert(
    bars(errored).includes("the fault pass"),
    "a 5xx while Google is failing ten percent of reads: the path must degrade, not error",
  );

  const empty = broken((i) => {
    i.faultPass = { attempts: 0, fiveXx: 0, faultPct: 10 };
  });
  assert(
    bars(empty).includes("the fault pass"),
    "and a fault pass that made no requests proves nothing, so zero 5xx is not a pass (L98)",
  );

  const none = broken((i) => {
    delete i.faultPass;
  });
  assert(!bars(none).includes("the fault pass"), "a run with no fault pass is judged on the rest");
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

{
  const i = passing();
  const want = i.burstResults.length;
  i.burstResults = i.burstResults.slice(0, want - 1);
  const why = incompleteness(i);
  assert(
    why.some((r) => r.includes("burst driver files")),
    "a burst leg missing a driver file is incomplete",
  );
  assert(
    why.some((r) => r.includes(String(want))),
    "and the reason says how many were expected",
  );
}

{
  const i = passing();
  i.burstResults = [];
  const why = incompleteness(i);
  assert(
    why.some((r) => r.includes("burst driver files")),
    "a burst leg that produced NOTHING is incomplete rather than treated as absent",
  );
}

{
  // A burst driver that fired fewer requests than it planned is a smaller burst
  // than the one being judged, and "exactly one 200" is satisfiable by a burst of
  // one.
  const i = passing();
  i.burstResults[0]!.attempts = i.burstResults[0]!.attempts.slice(0, 1);
  assert(
    incompleteness(i).some((r) => r.includes("of") && r.includes("planned requests")),
    "a burst driver that fired a fraction of its plan is incomplete",
  );
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
  i.faultPass = { attempts: 120, fiveXx: 0, faultPct: 0 };
  const why = incompleteness(i);
  assert(
    why.some((r) => r.includes("reporting 0 percent")),
    "a fault pass against a deployment at zero percent is incomplete, not a pass",
  );
  // The other direction (L159): the same pass at the configured percentage is
  // complete, so this is about the percentage rather than about the shape.
  const ok = passing();
  ok.faultPass = { attempts: 120, fiveXx: 0, faultPct: 10 };
  eq(incompleteness(ok).length, 0, "and the same pass at ten percent is complete");
}

{
  // A run that asked for no fault leg is not judged on one it happens to carry:
  // the expectation is what decides, so a hand run that drove a fault pass out of
  // curiosity still judges its bar without being called incomplete for the
  // percentage it chose.
  const i = passing();
  i.expectedLegs = { burstDrivers: i.burstResults.length, faultPct: 0 };
  i.faultPass = { attempts: 50, fiveXx: 0, faultPct: 25 };
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
    i.faultPass = { attempts: 30, fiveXx: 3, faultPct: 10 };
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
    i.platform = { invocations: 1, cpuMsP99: 10, subrequests: 8, statuses: { success: 1 }, cron: { invocations: 0, worstCpuMs: 0, byCron: {} } };
    i.faultPass = { attempts: 30, fiveXx: 3, faultPct: 10 };
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
    // cron lanes, and crons present in the window to prove it.
    i.platform.cpuMsP99 = 48_900;
    i.platform.cron = {
      invocations: 10,
      worstCpuMs: 74_365,
      byCron: { "* * * * *": { invocations: 10, worstCpuMs: 74_365 } },
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

finish();
