// The load run's speed verdict (#3517), driven offline.
//
// Two checks judge the steady p95, and each is held here from both sides (L1):
//
//  - the RATIO check, the p95 at most 2.5 times the same day baseline's median at rest
//    (#3258), whose baseline now drops its first bookings as a warm up and takes more
//    of them, because the first booking of a run is its slowest (#3517);
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
  BASELINE_MIN_OK,
  BASELINE_PER_MINUTE,
  BASELINE_PLANNED,
  BASELINE_WARMUP,
  LOAD_OVER_REST_RATIO_BAR,
  STEADY_P95_LIMIT_MS,
  judgeLatency,
  latencyFailureDetail,
  latencyReportLine,
  type LatencyJudgement,
} from "./loadtest/latency-bar.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const RUN = "run-3517";

/** One baseline booking at position `n` of the plan. */
function booking(n: number, wallMs: number, status = 200): BookingAttempt {
  return {
    driver: 0,
    n,
    code: "112",
    externalId: `${RUN}-r-0-${n}`,
    sentAtMs: 1_000_000 + n * 10_000,
    wallMs,
    status,
    outcome: status === 200 ? "created" : "SLOT_TAKEN",
    startIso: null,
    seenIp: null,
    echo: null,
  };
}

/** A baseline file holding these wall times in send order. */
function baselineOf(walls: readonly (number | { wallMs: number; status: number })[]): DriverResult {
  return {
    runId: RUN,
    driver: 0,
    mode: "baseline",
    planned: walls.length,
    startedAtMs: 1_000_000,
    finishedAtMs: 1_000_000 + walls.length * 10_000,
    attempts: walls.map((w, n) => (typeof w === "number" ? booking(n, w) : booking(n, w.wallMs, w.status))),
  };
}

const judge = (steadyP95: number, file: DriverResult, googleDelayed = false): LatencyJudgement =>
  judgeLatency({
    steadyP95,
    absoluteBarMs: 5000,
    baseline: { kind: "file", result: file },
    baselineExpected: true,
    runId: RUN,
    googleDelayed,
  });

/** A whole plan: the warm ups at `warmMs`, then every measured booking at `restMs`. */
const plan = (warmMs: number, restMs: number) =>
  baselineOf([...Array(BASELINE_WARMUP).fill(warmMs), ...Array(BASELINE_BOOKINGS).fill(restMs)]);

// --- the plan's shape -------------------------------------------------------------------
{
  eq(BASELINE_PLANNED, BASELINE_WARMUP + BASELINE_BOOKINGS, "the driver plans the warm ups and the measured bookings together");
  assert(BASELINE_WARMUP >= 1, "at least the first booking is dropped, the one that is slowest on most runs");
  assert(BASELINE_BOOKINGS > 12, "more bookings are measured than the twelve the swing was measured on");
  assert(BASELINE_MIN_OK <= BASELINE_BOOKINGS, "the sample floor is reachable");
  // The leg's length on the schedule, which is what it adds to a run: one gap per
  // booking after the first. Held to about a minute over the twelve at four a minute
  // it replaced (11 gaps of 15s, 165s).
  const spanMs = (BASELINE_PLANNED - 1) * (60_000 / BASELINE_PER_MINUTE);
  assert(spanMs - 165_000 <= 60_000, `the leg grows by at most a minute (it is ${(spanMs - 165_000) / 1000}s longer)`);
  assert(BASELINE_PER_MINUTE * 2 < 15, "it still paces well below one steady driver, so it measures the path at rest");
}

// --- the warm up is dropped before the median -------------------------------------------
{
  // Ten measured at 500 and ten at 700 have a median of 600. The two warm ups at 3000
  // would move it to 700 if they were counted, so the median says which happened.
  const walls = [3000, 3000, ...Array(10).fill(500), ...Array(10).fill(700)];
  const j = judge(1200, baselineOf(walls));
  eq(j.kind, "relative", "a whole baseline is judged against");
  if (j.kind === "relative") {
    eq(j.baselineP50, 600, "the median is taken over the measured bookings only");
    eq(j.baselineOk, BASELINE_BOOKINGS, "and counts the measured bookings, not the warm ups");
    eq(j.warmupMs, [3000, 3000], "the dropped warm ups are kept, so the report can show what was dropped");
    eq(j.ratioBarMs, Math.round(600 * LOAD_OVER_REST_RATIO_BAR), "the ratio bar is the multiple of that median");
  }

  // Dropped by POSITION, not by speed: a fast first booking is dropped all the same,
  // and a slow later one is kept, so the rule cannot flatter the baseline.
  const fastFirst = judge(1200, baselineOf([100, 100, ...Array(BASELINE_BOOKINGS).fill(800)]));
  assert(fastFirst.kind === "relative" && fastFirst.baselineP50 === 800, "the first bookings are dropped even when fast");

  // A warm up refused still counts as the warm up, and its success never counts toward
  // the floor: a thin measured sample is unmeasured however the warm ups went.
  const thin = judge(
    1200,
    baselineOf([
      600,
      600,
      ...Array(BASELINE_MIN_OK - 1).fill(600),
      ...Array(BASELINE_BOOKINGS - (BASELINE_MIN_OK - 1)).fill({ wallMs: 300, status: 409 }),
    ]),
  );
  eq(thin.kind, "unmeasured", "fewer measured successes than the floor is unmeasured, whatever the warm ups did");
  assert(thin.kind === "unmeasured" && thin.why.includes(`${BASELINE_MIN_OK}`), "and says how many it needs");
}

// --- ratio passes, fixed limit fails ----------------------------------------------------
{
  // A slow baseline lets a slow run through the ratio: 2000 is 2.0 times a 1000ms
  // baseline, inside 2.5, and over the fixed limit.
  const p95 = STEADY_P95_LIMIT_MS + 200;
  const j = judge(p95, plan(1000, 1000));
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
  const j = judge(1500, plan(500, 500));
  assert(j.kind === "relative" && !j.ratioPass && j.fixedPass && !j.pass, "the ratio fails it on its own");
  if (j.kind === "relative") {
    eq(j.failedChecks, ["ratio"], "only the ratio is named as failed");
    const detail = latencyFailureDetail(j, { p50: 700, max: 1900 });
    assert(/failed the ratio check/.test(detail) && detail.includes("3.0 times"), `the finding names the ratio and the multiple: ${detail}`);
    assert(detail.includes(`${STEADY_P95_LIMIT_MS}ms`), `and states the fixed limit it stayed inside: ${detail}`);
  }
}

// --- both fail ----------------------------------------------------------------------------
{
  const p95 = STEADY_P95_LIMIT_MS + 400;
  const j = judge(p95, plan(600, 600));
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
  const j = judge(STEADY_P95_LIMIT_MS, plan(800, 800));
  assert(j.kind === "relative" && j.pass && j.failedChecks.length === 0, "a p95 AT the fixed limit, inside the ratio, passes");
  const line = latencyReportLine(j);
  assert(line.includes(`${BASELINE_BOOKINGS} bookings at rest`) && line.includes(`first ${BASELINE_WARMUP} dropped`), `the report says what the median was taken over: ${line}`);
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
  const delayed = judge(p95, plan(1000, 1000), true);
  assert(delayed.kind === "relative" && delayed.pass && delayed.fixedLimitMs === null, "a delayed run is judged on the ratio alone");
  const line = latencyReportLine(delayed);
  assert(/not applied/.test(line) && /delay/.test(line), `and the report says the fixed limit was not applied, and why: ${line}`);
  const ratioFail = judge(3000, plan(1000, 1000), true);
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
