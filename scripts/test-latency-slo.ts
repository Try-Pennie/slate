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
  LATENCY_SAMPLES,
  AVAILABILITY_P50_BUDGET_MS,
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

finish();
