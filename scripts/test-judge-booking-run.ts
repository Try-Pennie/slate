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
    ipCeilingControl: { sent: 61, firstRefusedAt: 61 },
    platform: { invocations: 610, cpuMsP99: 40, outcomes: { ok: 610 } },
    faultPass: { attempts: 100, fiveXx: 0, faultPct: 10 },
    expectedLegs: { burstDrivers: burstResults.length, faultPct: 10 },
    budgets: { cpuMsP99: 200 },
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

// --- the per address ceiling, proved by its own step ---------------------------------

{
  const never = broken((i) => {
    i.ipCeilingControl = { sent: 61, firstRefusedAt: null };
  });
  assert(
    bars(never).includes("the per address write ceiling"),
    "sixty one writes from one address with none refused means the ceiling is not applying, so " +
      "every 429 the run attributed means something else",
  );

  const notRun = broken((i) => {
    i.ipCeilingControl = { sent: 0, firstRefusedAt: null };
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
    i.ipCeilingControl = { sent: 61, firstRefusedAt: 20 };
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
    i.platform.cpuMsP99 = 250;
  });
  assert(bars(hot).includes("Worker CPU"), "CPU over the lane budget is a finding");

  // SUBREQUESTS are deliberately not a bar: Cloudflare exposes no counter for them,
  // so one would leave this judge permanently unable to conclude, which is the
  // shape #2240's first cal.com probe shipped in. The BREACH is measurable and is
  // what is judged, through the outcome histogram.
  const killed = broken((i) => {
    i.platform.outcomes = { ok: 600, exceededCpu: 10 };
  });
  assert(bars(killed).includes("platform outcome"), "an invocation the platform cut off is a finding");
  assert(
    killed.findings.find((f) => f.bar === "platform outcome")!.detail.includes("exceededCpu"),
    "named by WHICH outcome, since a CPU kill and a subrequest breach are different things to fix",
  );

  const breached = broken((i) => {
    i.platform.outcomes = { ok: 609, scriptThrewException: 1 };
  });
  assert(bars(breached).includes("platform outcome"), "and so is any other non-ok outcome");

  const noOutcomes = broken((i) => {
    i.platform.outcomes = {};
  });
  eq(
    noOutcomes.verdict,
    "unmeasured",
    "an EMPTY histogram is a reading that found nothing, never every invocation being fine",
  );

  const nullOutcomes = broken((i) => {
    i.platform.outcomes = null;
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
    i.platform = { invocations: null, cpuMsP99: null, outcomes: null };
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
    i.platform = { invocations: null, cpuMsP99: null, outcomes: null };
  });
  eq(r.verdict, "unmeasured", "a clean run with an unreadable platform half is unmeasured");
  eq(r.findings.length, 1, "carrying the one finding it has");
  eq(r.findings[0]!.bar, "platform limits", "which is the platform one");
}

{
  // The same, for the invocation CONTROL: a lagging pipeline must not erase a
  // measured failure either.
  const r = broken((i) => {
    i.platform = { invocations: 1, cpuMsP99: 10, outcomes: { ok: 1 } };
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

finish();
