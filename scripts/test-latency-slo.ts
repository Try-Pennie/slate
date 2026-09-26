// #1047: the canary's latency verdict.
//
// The canary proved the funnel WORKS and said nothing about whether it is fast, so a
// latency regression relied on somebody noticing a page felt slow, which for a lead who
// abandons is nobody.
//
// Everything asserted here is about not shipping a flapping alert, because an alert that
// cries wolf gets ignored (L36) and a latency check is the classic source of one. The
// three properties that make it survivable are the cold-sample drop, the median, and a
// budget an order of magnitude above the measured warm number.
//
// Run: node --experimental-strip-types scripts/test-latency-slo.ts
import {
  judgeLatency,
  median,
  measureLatency,
  LATENCY_SAMPLES,
  LATENCY_RECHECK_DELAY_MS,
  AVAILABILITY_P50_BUDGET_MS,
  type LatencyRun,
} from "./lib/latency-slo.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- the median ---------------------------------------------------------------
eq(median([]), null, "no samples give no median, never 0");
eq(median([5]), 5, "one sample");
eq(median([9, 1, 5]), 5, "an odd count takes the middle of the SORTED values");
eq(median([1, 2, 3, 10]), 2.5, "an even count takes the mean of the two middles");

// --- the cold sample is always dropped ---------------------------------------
{
  // The first request after an idle period pays isolate startup, so counting it
  // measures how quiet the morning was rather than how fast the endpoint is. This is
  // the assertion that keeps a healthy run from paging after a lull.
  const v = judgeLatency([5000, 40, 42, 38, 41]);
  eq(v.regressed, false, "one cold first sample does not trip the budget");
  assert(v.medianMs !== null && v.medianMs < 100, `the median ignores it (${v.medianMs})`);
}
{
  // And it is dropped even when it would have HELPED, so the rule is the rule rather
  // than a filter that only ever flatters the result.
  const v = judgeLatency([10, 900, 900, 900, 900]);
  eq(v.regressed, true, "a fast first sample does not rescue a slow run");
}

// --- one slow sample among fast ones is not a regression ---------------------
{
  const v = judgeLatency([50, 45, 3000, 48, 44]);
  eq(v.regressed, false, "a single outlier does not trip the budget");
}

// --- a real regression trips ---------------------------------------------------
{
  const v = judgeLatency([700, 800, 900, 850, 820]);
  eq(v.regressed, true, "a sustained slow read is a regression");
  assert(v.message !== null && /median/.test(v.message), "and the message names the median");
  assert(
    v.message !== null && /cache/.test(v.message),
    "and points at the likely cause, since the budget is far above the warm number so " +
      "the realistic explanation is a read that stopped being cached",
  );
}
{
  // Exactly at the budget is not over it: a boundary that fires ON the number turns the
  // budget into "under the budget", which is not what it says.
  eq(judgeLatency([0, AVAILABILITY_P50_BUDGET_MS]).regressed, false, "the budget itself passes");
  eq(judgeLatency([0, AVAILABILITY_P50_BUDGET_MS + 1]).regressed, true, "one past it fails");
}

// --- nothing measured is not a pass, and not a failure -----------------------
{
  // Both halves matter. It must not silently pass (L98), and it must not fail either:
  // a canary that could not reach the endpoint at all already fails on the availability
  // check itself, and failing twice for one cause is how an alert stops naming its
  // cause.
  for (const samples of [[], [42]]) {
    const v = judgeLatency(samples);
    eq(v.medianMs, null, `no usable samples give no median (${JSON.stringify(samples)})`);
    eq(v.regressed, false, "and do not report a regression");
    assert(
      v.message !== null && /not measured/i.test(v.message),
      "but SAY that nothing was measured, rather than reading as a healthy pass",
    );
  }
}
{
  // A non-finite sample cannot be averaged into a number: NaN compares false against
  // every threshold, so it would silently mean "fast" (L50).
  const v = judgeLatency([10, Number.NaN, Number.POSITIVE_INFINITY, -1]);
  eq(v.medianMs, null, "unusable samples are dropped rather than poisoning the median");
}

// --- the numbers are sane relative to each other -----------------------------
{
  assert(LATENCY_SAMPLES >= 3, "enough samples that the median is not one request");
  // The measured warm read is about 39ms (#256). A budget near it would page on
  // ordinary variance; this is a regression detector, not a performance target.
  assert(
    AVAILABILITY_P50_BUDGET_MS >= 300,
    `the budget is far above the warm read, so ordinary variance cannot trip it (${AVAILABILITY_P50_BUDGET_MS}ms)`,
  );
  assert(
    AVAILABILITY_P50_BUDGET_MS <= 2000,
    "and still low enough that a read a lead would notice is caught",
  );
}

// --- #2811: one slow batch is re-measured before anybody is paged -------------
//
// 590 canary runs from 2026-09-11 to 2026-09-26 went over budget 10 times, and the run
// after every one of the 10 read between 38ms and 204ms. So a single slow batch has
// never once been the start of a real regression, while it paged somebody about every
// day and a half. The fixtures below are those runs' real samples.
//
// The fake takes batches off a list and records every sleep, so nothing here waits
// for real (L524) and the pause itself is asserted rather than assumed.
function fakeRun(batches: number[][]) {
  const sleeps: number[] = [];
  let taken = 0;
  const deps = {
    takeBatch: async () => batches[taken++] ?? [],
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
  return { deps, sleeps, taken: () => taken };
}

const ONE_OFF_2026_09_26 = [2162, 114, 353, 1090, 960]; // run 36252424908, median 657ms
const NEXT_RUN_2026_09_26 = [166, 120, 51, 41, 45]; // run 36253396530, median 48ms
const SUSTAINED = [700, 800, 900, 850, 820];

{
  const f = fakeRun([ONE_OFF_2026_09_26, NEXT_RUN_2026_09_26]);
  const run: LatencyRun = await measureLatency(f.deps);
  eq(run.kind, "passing-blip", "the 2026-09-26 one-off reads as a passing blip");
  eq(run.page, false, "and pages nobody");
  eq(run.measured, true, "while still counting as a measured reading");
  eq(f.taken(), 2, "because a second batch was taken");
  eq(f.sleeps, [LATENCY_RECHECK_DELAY_MS], "after exactly one pause of the recheck delay");
  assert(
    run.message !== null && /657ms/.test(run.message) && /48ms/.test(run.message),
    `and the log line names both medians, so the blip is visible in the run (${run.message})`,
  );
}
{
  const f = fakeRun([SUSTAINED, SUSTAINED]);
  const run = await measureLatency(f.deps);
  eq(run.kind, "confirmed", "a read slow on both batches is a confirmed regression");
  eq(run.page, true, "and it pages, in the same run rather than a cadence later");
  assert(
    run.message !== null && /835ms/.test(run.message) && /again/.test(run.message),
    `the page names the recheck, so the reader knows it was not one slow minute (${run.message})`,
  );
  assert(run.message !== null && /cache/.test(run.message), "and still points at the cache");
}
{
  // Slow, then the endpoint stops answering at all. That is not a blip to swallow: the
  // one thing known is that it was slow, and nothing since says otherwise.
  const f = fakeRun([SUSTAINED, []]);
  const run = await measureLatency(f.deps);
  eq(run.kind, "recheck-unmeasured", "a recheck with no usable readings is its own outcome");
  eq(run.page, true, "and it pages rather than letting the slow reading go unreported");
  assert(
    run.message !== null && /could not be re-measured|no usable/.test(run.message),
    `and says the recheck measured nothing, rather than claiming a confirmation (${run.message})`,
  );
}
{
  const f = fakeRun([NEXT_RUN_2026_09_26]);
  const run = await measureLatency(f.deps);
  eq(run.kind, "healthy", "a batch inside the budget is healthy");
  eq(run.page, false, "pages nobody");
  eq(run.measured, true, "and is a measured reading");
  eq(f.taken(), 1, "with no second batch");
  eq(f.sleeps, [], "and no pause, so a healthy run costs no extra minutes");
}
{
  // #1700: the one outcome that must NOT count as measured.
  const f = fakeRun([[42]]);
  const run = await measureLatency(f.deps);
  eq(run.kind, "not-measured", "a batch with nothing to judge is not measured");
  eq(run.measured, false, "so it stamps no verdict");
  eq(run.page, false, "and does not page either, for the reason judgeLatency gives");
  eq(f.taken(), 1, "and it does not recheck something it never measured");
}
{
  // The fixture list is the real history, so check it says what the comment claims.
  const blips = [
    [456, 68, 1192, 1140, 669],
    [631, 87, 1092, 79, 987],
    [1076, 963, 2067, 479, 71],
    [1628, 1624, 1472, 1455, 1954],
    [268, 146, 149, 1109, 1183],
    [1437, 1331, 98, 75, 1302],
    [473, 80, 1259, 1183, 75],
    [1622, 1460, 273, 1068, 101],
    [1104, 971, 2009, 110, 114],
    ONE_OFF_2026_09_26,
  ];
  for (const b of blips) {
    assert(judgeLatency(b).regressed, `the historical one-off ${JSON.stringify(b)} was over budget`);
    const run = await measureLatency(fakeRun([b, NEXT_RUN_2026_09_26]).deps);
    eq(run.page, false, `and with a healthy recheck it would not have paged (${JSON.stringify(b)})`);
  }
}
{
  // The pause has to be long enough to outlast the slow stretches in that history, which
  // span one run's five requests (a few seconds), and short enough to leave the job well
  // inside its 15 minute timeout.
  assert(LATENCY_RECHECK_DELAY_MS >= 60_000, "the recheck waits at least a minute");
  assert(LATENCY_RECHECK_DELAY_MS <= 5 * 60_000, "and no more than five, inside the job timeout");
}

finish();
