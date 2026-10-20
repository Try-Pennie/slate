// The load run's speed verdict (#3517, #3914), driven offline.
//
// Two checks judge the steady p95, and each is held here from both sides (L1):
//
//  - the RATIO check, the p95 at most 2.5 times the same day baseline's median at rest
//    (#3258), whose baseline drops each runner's first bookings as a warm up, because
//    the first booking an address sends is its slowest (#3517), and since #3914 is
//    SPREAD across several runners, because where one runner's per address limiter
//    object answers from moved the whole sample;
//  - the FIXED limit, a ceiling on the p95 that holds whatever the baseline reads, so a
//    run whose baseline is itself slow cannot pass at a slow absolute speed.
//
// A failure names which check failed and states both numbers, so a reader never has to
// work out from one number which rule a run broke (L11).
//
// Run: node --experimental-strip-types scripts/test-loadtest-speed-verdict.ts
import type { BookingAttempt, DriverResult } from "./loadtest/book-plan.ts";
import {
  BASELINE_BOOKINGS,
  BASELINE_BOOKINGS_PER_RUNNER,
  BASELINE_GAP_MS,
  BASELINE_MIN_OK_PER_RUNNER,
  BASELINE_PER_MINUTE,
  BASELINE_PLANNED,
  BASELINE_RUNNERS,
  BASELINE_WARMUP,
  LOAD_OVER_REST_RATIO_BAR,
  STEADY_P95_LIMIT_MS,
  judgeLatency,
  latencyFailureDetail,
  latencyReportLine,
  type LatencyJudgement,
} from "./loadtest/latency-bar.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const RUN = "run-3914";

type Wall = number | { wallMs: number; status: number };

/** One baseline booking by runner `driver` at position `n` of its plan. */
function booking(driver: number, n: number, wallMs: number, status = 200, seenIp: string | null = null): BookingAttempt {
  return {
    driver,
    n,
    code: "112",
    externalId: `${RUN}-r-${driver}-${n}`,
    sentAtMs: 1_000_000 + n * 30_000 + driver * 10_000,
    wallMs,
    status,
    outcome: status === 200 ? "created" : "SLOT_TAKEN",
    startIso: null,
    seenIp,
    echo: null,
  };
}

/** One runner's baseline file holding these wall times in send order. */
function runnerOf(driver: number, walls: readonly Wall[], seenIp: string | null = `10.0.0.${driver + 1}`): DriverResult {
  return {
    runId: RUN,
    driver,
    mode: "baseline",
    planned: walls.length,
    startedAtMs: 1_000_000,
    finishedAtMs: 1_000_000 + walls.length * 30_000,
    attempts: walls.map((w, n) =>
      typeof w === "number" ? booking(driver, n, w, 200, seenIp) : booking(driver, n, w.wallMs, w.status, seenIp),
    ),
  };
}

/** A runner's whole plan: its warm ups at `warmMs`, then every measured booking at `restMs`. */
const runnerPlan = (driver: number, warmMs: number, restMs: number, seenIp?: string | null) =>
  runnerOf(driver, [...Array(BASELINE_WARMUP).fill(warmMs), ...Array(BASELINE_BOOKINGS_PER_RUNNER).fill(restMs)], seenIp);

/** Every runner on the same plan, which is the shape the old single runner tests assumed. */
const allAt = (warmMs: number, restMs: number) =>
  Array.from({ length: BASELINE_RUNNERS }, (_, d) => runnerPlan(d, warmMs, restMs));

const judge = (steadyP95: number, files: DriverResult[], googleDelayed = false): LatencyJudgement =>
  judgeLatency({
    steadyP95,
    absoluteBarMs: 5000,
    baseline: { kind: "runners", results: files },
    baselineExpected: true,
    runId: RUN,
    googleDelayed,
  });

// --- the plan's shape -------------------------------------------------------------------
{
  assert(BASELINE_RUNNERS >= 3, "the baseline is spread across at least three runners, so one placement is never the majority");
  eq(BASELINE_PLANNED, BASELINE_WARMUP + BASELINE_BOOKINGS_PER_RUNNER, "each runner plans its own warm ups and its measured bookings");
  eq(BASELINE_BOOKINGS, BASELINE_RUNNERS * BASELINE_BOOKINGS_PER_RUNNER, "the median is pooled over every runner's measured bookings");
  assert(BASELINE_WARMUP >= 1, "at least the first booking each address sends is dropped, the one that is slowest on most runs");
  assert(BASELINE_BOOKINGS >= 20, "at least the twenty bookings #3517 measured are pooled, so the sampling spread is no wider");
  assert(BASELINE_MIN_OK_PER_RUNNER <= BASELINE_BOOKINGS_PER_RUNNER, "the per runner floor is reachable");
  assert(
    BASELINE_MIN_OK_PER_RUNNER * 3 >= BASELINE_BOOKINGS_PER_RUNNER * 2,
    "and asks for at least two thirds of each runner's measured bookings, the share #3517's floor held",
  );
  // The deployment still sees one booking every ten seconds, the pace the ratio was
  // calibrated at (#3517): each runner sends one every runners times ten seconds, and
  // the runners take turns.
  eq(BASELINE_GAP_MS, 10_000, "the deployment sees one baseline booking every ten seconds, as before");
  eq(BASELINE_PER_MINUTE * BASELINE_RUNNERS, 6, "so the runners together send six a minute, as the one runner did");
  // The leg's length on the schedule: one runner's gaps plus the turn it may wait for.
  const spanMs = (BASELINE_PLANNED - 1) * (60_000 / BASELINE_PER_MINUTE) + BASELINE_GAP_MS * BASELINE_RUNNERS;
  assert(spanMs - 210_000 <= 90_000, `the leg grows by at most a minute and a half over #3517's 210s (it is ${(spanMs - 210_000) / 1000}s longer)`);
  assert(BASELINE_PER_MINUTE * BASELINE_RUNNERS * 2 < 15, "it still paces well below one steady driver, so it measures the path at rest");
}

// --- each runner's warm up is dropped before the pooled median ----------------------------
{
  // Each runner: two warm ups at 3000, then measured bookings split between 500 and 700.
  // Counting the warm ups would move the pooled median; dropping them leaves it inside
  // the measured values.
  const files = Array.from({ length: BASELINE_RUNNERS }, (_, d) =>
    runnerOf(d, [3000, 3000, ...Array.from({ length: BASELINE_BOOKINGS_PER_RUNNER }, (_, i) => (i % 2 === 0 ? 500 : 700))]),
  );
  const j = judge(1200, files);
  eq(j.kind, "relative", "a whole spread baseline is judged against");
  if (j.kind === "relative") {
    assert(j.baselineP50 === 500 || j.baselineP50 === 700, `the median is taken over the measured bookings only (got ${j.baselineP50})`);
    eq(j.baselineOk, BASELINE_BOOKINGS, "and counts every runner's measured bookings, not the warm ups");
    eq(j.runners.length, BASELINE_RUNNERS, "every runner is reported");
    eq(j.runners[0]!.warmupMs, [3000, 3000], "each runner's dropped warm ups are kept, so the report can show what was dropped");
    eq(j.ratioBarMs, Math.round(j.baselineP50 * LOAD_OVER_REST_RATIO_BAR), "the ratio bar is the multiple of that median");
  }

  // Dropped by POSITION, not by speed: a fast first booking is dropped all the same.
  const fastFirst = judge(1200, Array.from({ length: BASELINE_RUNNERS }, (_, d) => runnerPlan(d, 100, 800)));
  assert(fastFirst.kind === "relative" && fastFirst.baselineP50 === 800, "the first bookings are dropped even when fast");
}

// --- #3914: one runner's placement no longer sets the baseline ----------------------------
{
  // Run 39090439214's case: one runner's limiter object answered slowly, so its bookings
  // read about 840ms while the other runners' read 580 and 600. The pooled median sits
  // with the majority, where a baseline sent from that one runner alone would have read
  // its 842.
  const oneSlow = [runnerPlan(0, 900, 842), runnerPlan(1, 900, 580), runnerPlan(2, 900, 600)];
  const j = judge(1450, oneSlow);
  assert(j.kind === "relative", "a spread baseline with one slow runner is still judged");
  if (j.kind === "relative") {
    eq(j.baselineP50, 600, "one slow runner does not set the baseline: the median sits with the other runners");
    eq(
      j.runners.map((r) => r.medianMs),
      [842, 580, 600],
      "each runner's own median is reported, so a reader sees which placement was slow",
    );
  }
  // The other direction (L497), the issue's actual risk: one runner FAST makes the ratio
  // too strict. Two at today's 640 and one at 420 keep the median at 640, so a 1500ms p95
  // (2.3 times) passes where the fast runner alone (3.6 times) would have failed it.
  const oneFast = [runnerPlan(0, 900, 420), runnerPlan(1, 900, 640), runnerPlan(2, 900, 650)];
  const f = judge(1500, oneFast);
  assert(f.kind === "relative" && f.baselineP50 === 640 && f.ratioPass, `one fast runner does not make the ratio too strict (${JSON.stringify(f)})`);
  const aloneFast = judge(1500, [runnerPlan(0, 900, 420), runnerPlan(1, 900, 420), runnerPlan(2, 900, 420)]);
  assert(aloneFast.kind === "relative" && !aloneFast.ratioPass, "control: a baseline that is fast on every runner still fails the ratio");
  // A majority slow is reported as the majority: the rule is a median, not a minimum.
  const twoSlow = judge(1450, [runnerPlan(0, 900, 842), runnerPlan(1, 900, 830), runnerPlan(2, 900, 600)]);
  assert(twoSlow.kind === "relative" && twoSlow.baselineP50 === 830, "two slow runners of three set the median, never the fastest runner");
}

// --- the addresses the baseline was spread across -----------------------------------------
{
  // The limiter keys its object on the address it SEES (#3456), which the deployment
  // echoes on the load test path. Three runners behind one address shared one object,
  // so the report says how many addresses the spread really reached.
  const spread = judge(1400, allAt(900, 600));
  assert(spread.kind === "relative" && spread.addresses === BASELINE_RUNNERS, "three runners on three addresses are three addresses");
  const shared = judge(1400, [runnerPlan(0, 900, 600, "10.9.9.9"), runnerPlan(1, 900, 600, "10.9.9.9"), runnerPlan(2, 900, 600, "10.0.0.3")]);
  assert(shared.kind === "relative" && shared.addresses === 2, "two runners behind one address count once");
  const line = latencyReportLine(shared);
  assert(/2 addresses/.test(line) && new RegExp(`${BASELINE_RUNNERS} runners`).test(line), `the report says the spread reached fewer addresses than runners: ${line}`);
  const unseen = judge(1400, Array.from({ length: BASELINE_RUNNERS }, (_, d) => runnerPlan(d, 900, 600, null)));
  assert(unseen.kind === "relative" && unseen.addresses === null, "no echoed address is null, never zero (L90)");
  assert(/address/.test(latencyReportLine(unseen)), `and the report says the addresses were not echoed: ${latencyReportLine(unseen)}`);
}

// --- a runner too thin, or missing, voids the speed verdict ---------------------------------
{
  // A runner that confirmed fewer than its floor leaves the median on fewer placements
  // than the run claims, so the speed is unmeasured, naming the runner (L11).
  const thinRunner = runnerOf(1, [
    600,
    600,
    ...Array(BASELINE_MIN_OK_PER_RUNNER - 1).fill(600),
    ...Array(BASELINE_BOOKINGS_PER_RUNNER - (BASELINE_MIN_OK_PER_RUNNER - 1)).fill({ wallMs: 300, status: 409 }),
  ]);
  const thin = judge(1200, [runnerPlan(0, 600, 600), thinRunner, runnerPlan(2, 600, 600)]);
  eq(thin.kind, "unmeasured", "a runner below its floor is unmeasured, however well the others did");
  assert(
    thin.kind === "unmeasured" && thin.why.includes("runner 1") && thin.why.includes(`${BASELINE_MIN_OK_PER_RUNNER}`),
    `and says which runner and how many it needs: ${thin.kind === "unmeasured" ? thin.why : ""}`,
  );
  // A warm up refused still counts as the warm up, and its success never counts toward
  // the floor.
  const warmOnly = runnerOf(2, [600, 600, ...Array(BASELINE_BOOKINGS_PER_RUNNER).fill({ wallMs: 300, status: 409 })]);
  eq(judge(1200, [runnerPlan(0, 600, 600), runnerPlan(1, 600, 600), warmOnly]).kind, "unmeasured", "warm up successes never count toward the floor");
  // Fewer files than runners is the reading's business, but a judge handed a short set
  // must not pool it as though the spread were whole.
  const short = judge(1200, [runnerPlan(0, 600, 600), runnerPlan(2, 600, 600)]);
  assert(short.kind === "unmeasured" && short.why.includes("runner 1"), `a missing runner is unmeasured, naming it: ${JSON.stringify(short)}`);
  const otherRun = judge(1200, [runnerPlan(0, 600, 600), { ...runnerPlan(1, 600, 600), runId: "run-older" }, runnerPlan(2, 600, 600)]);
  assert(otherRun.kind === "unmeasured" && otherRun.why.includes("run-older"), "one runner's file from another run is unmeasured, naming the run");
}

// --- ratio passes, fixed limit fails ----------------------------------------------------
{
  // A slow baseline lets a slow run through the ratio: 2000 is 2.0 times a 1000ms
  // baseline, inside 2.5, and over the fixed limit.
  const p95 = STEADY_P95_LIMIT_MS + 200;
  const j = judge(p95, allAt(1000, 1000));
  assert(j.kind === "relative" && j.ratioPass, "the ratio check passes");
  assert(j.kind === "relative" && !j.fixedPass && !j.pass, "the fixed limit fails it, so the speed verdict fails");
  if (j.kind === "relative") {
    eq(j.failedChecks, ["fixed limit"], "only the fixed limit is named as failed");
    const detail = latencyFailureDetail(j, { p50: 900, max: 2600 });
    assert(detail.includes("fixed limit") && detail.includes(`${STEADY_P95_LIMIT_MS}ms`), `the finding names the fixed limit: ${detail}`);
    assert(detail.includes(`${j.ratioBarMs}ms`) && detail.includes(`${p95}ms`), `and states the ratio bar and the p95 too: ${detail}`);
    assert(!/failed the ratio/.test(detail) && !/failed both/.test(detail), `and does not say the ratio failed: ${detail}`);
  }
}

// --- ratio fails, fixed limit passes ----------------------------------------------------
{
  // A fast day: 1500 is 3.0 times a 500ms baseline, and inside the fixed limit.
  const j = judge(1500, allAt(500, 500));
  assert(j.kind === "relative" && !j.ratioPass && j.fixedPass && !j.pass, "the ratio fails it on its own");
  if (j.kind === "relative") {
    eq(j.failedChecks, ["ratio"], "only the ratio is named as failed");
    const detail = latencyFailureDetail(j, { p50: 700, max: 1900 });
    assert(/failed the ratio check/.test(detail) && detail.includes("3.0 times"), `the finding names the ratio and the multiple: ${detail}`);
    assert(detail.includes(`${STEADY_P95_LIMIT_MS}ms`), `and states the fixed limit it stayed inside: ${detail}`);
    assert(detail.includes(`${BASELINE_RUNNERS} runners`), `and says the baseline was spread across the runners: ${detail}`);
  }
}

// --- both fail ----------------------------------------------------------------------------
{
  const p95 = STEADY_P95_LIMIT_MS + 400;
  const j = judge(p95, allAt(600, 600));
  assert(j.kind === "relative" && !j.ratioPass && !j.fixedPass && !j.pass, "both checks fail");
  if (j.kind === "relative") {
    eq(j.failedChecks, ["ratio", "fixed limit"], "both are named, ratio first");
    const detail = latencyFailureDetail(j, { p50: 800, max: 3000 });
    assert(/failed both/.test(detail), `the finding says both failed: ${detail}`);
    assert(detail.includes(`${j.ratioBarMs}ms`) && detail.includes(`${STEADY_P95_LIMIT_MS}ms`), `with both numbers: ${detail}`);
  }
}

// --- both pass, and the boundary is inclusive -------------------------------------------
{
  const j = judge(STEADY_P95_LIMIT_MS, allAt(800, 800));
  assert(j.kind === "relative" && j.pass && j.failedChecks.length === 0, "a p95 AT the fixed limit, inside the ratio, passes");
  const line = latencyReportLine(j);
  assert(
    line.includes(`${BASELINE_BOOKINGS} bookings at rest`) && line.includes(`${BASELINE_RUNNERS} runners`) && line.includes(`first ${BASELINE_WARMUP}`),
    `the report says what the median was taken over: ${line}`,
  );
  assert(line.includes("runner 0 800ms"), `and each runner's own median: ${line}`);
  assert(line.includes(`${LOAD_OVER_REST_RATIO_BAR} times`) && line.includes(`${STEADY_P95_LIMIT_MS}ms fixed limit`), `and names both checks: ${line}`);
  assert(!line.includes("5000ms"), `and no longer states the old 5s bar beside them: ${line}`);
}

// --- with a Google delay the fixed limit does not apply ------------------------------------
{
  // The limit was calibrated on runs whose Google stand in answered at once (#3490). A
  // run dispatched with a delay carries Google time in every confirm, so the limit is
  // reported as not applied, and said so, rather than failing a run for what it was asked
  // to add. The ratio still judges it, since its baseline carries the delay too.
  const p95 = STEADY_P95_LIMIT_MS + 200;
  const delayed = judge(p95, allAt(1000, 1000), true);
  assert(delayed.kind === "relative" && delayed.pass && delayed.fixedLimitMs === null, "a delayed run is judged on the ratio alone");
  const line = latencyReportLine(delayed);
  assert(/not applied/.test(line) && /delay/.test(line), `and the report says the fixed limit was not applied, and why: ${line}`);
  const ratioFail = judge(3000, allAt(1000, 1000), true);
  assert(ratioFail.kind === "relative" && !ratioFail.pass && ratioFail.failedChecks.join() === "ratio", "and the ratio still fails it");
  if (ratioFail.kind === "relative") {
    const detail = latencyFailureDetail(ratioFail, { p50: 1500, max: 3200 });
    assert(
      detail.includes("failed the ratio check") && detail.includes("fixed limit was not applied") && !detail.includes("inside the"),
      `naming the ratio, and saying the fixed limit was not applied rather than that the run was inside it: ${detail}`,
    );
  }
}

finish();
