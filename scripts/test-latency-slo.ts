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
  decideDualLatency,
  LATENCY_SAMPLES,
  LATENCY_RECHECK_DELAY_MS,
  AVAILABILITY_P50_BUDGET_MS,
  readSlotCache,
  parseServerTiming,
  classifySlowReads,
  latencyCause,
  formatSamples,
  type LatencyRun,
  type LatencySample,
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
  // #3653: these bare numbers carry no x-slot-cache, so the message may NOT claim the
  // cache stopped serving (it used to, and on 2026-10-12 8 of 10 reads were hits). It
  // says it could not tell, which still names the cache as the open question.
  assert(
    v.message !== null && /could not tell/.test(v.message) && /cache/.test(v.message),
    `and says it could not tell whether the cache served the reads (${v.message})`,
  );
  assert(
    v.message !== null && !/stopped being served|stopped serving/.test(v.message),
    "and never claims a cache miss it did not measure",
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
  assert(
    run.message !== null && /could not tell/.test(run.message) && !/stopped serving/.test(run.message),
    `and, with no cache header on these samples, says it could not tell rather than blaming the cache (${run.message})`,
  );
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

// --- #3586: the dual-bucket decision ------------------------------------------
//
// The SMOKE bucket's cache is churned by the canary's own book and cancel on every
// pass, so a cold SMOKE read paged as a production slowdown on 2026-10-10 while a real
// lead on bucket 112 was unaffected. The decision now pages on the REAL bucket (the
// production signal, whose cache the canary never touches) and keeps SMOKE as a
// comparison only, so a churned-test-cache blip is logged but never pages.
{
  const HEALTHY = [166, 120, 51, 41, 45]; // median 48ms
  const SLOW = [700, 800, 900, 850, 820]; // median 835ms
  const realHealthy = await measureLatency(fakeRun([HEALTHY]).deps);
  const realConfirmed = await measureLatency(fakeRun([SLOW, SLOW]).deps); // page: true
  const realNotMeasured = await measureLatency(fakeRun([[42]]).deps); // one usable sample, no median
  const smokeHealthy = judgeLatency(HEALTHY);
  const smokeSlow = judgeLatency(SLOW);

  {
    // A real regression pages, whatever SMOKE says, and the page NAMES the real bucket
    // it is about so the reader does not mistake the SMOKE note for the subject.
    const d = decideDualLatency(realConfirmed, smokeSlow, "100");
    eq(d.page, true, "a confirmed REAL regression pages");
    eq(d.measured, true, "and counts as a measured verdict");
    assert(d.message !== null && /\d+ms/.test(d.message), `the page names the median (${d.message})`);
    assert(d.message !== null && /real bucket 100/.test(d.message), `and names the real bucket (${d.message})`);
  }
  {
    // The #3586 fix: a SMOKE-only blip over a healthy real bucket does NOT page.
    const d = decideDualLatency(realHealthy, smokeSlow, "100");
    eq(d.page, false, "a SMOKE blip over a healthy real bucket does not page");
    eq(d.measured, true, "the real bucket still measured, so the verdict stamps");
    assert(
      d.message !== null && /smoke/i.test(d.message) && /(blip|test[- ]cache|not a production)/i.test(d.message),
      `and the log says the SMOKE blip was seen and dismissed (${d.message})`,
    );
  }
  {
    // Both healthy: no page, and nothing to say beyond the measured reading.
    const d = decideDualLatency(realHealthy, smokeHealthy, "100");
    eq(d.page, false, "both healthy pages nobody");
    eq(d.measured, true, "and is a measured reading");
  }
  {
    // A real passing-blip (first batch slow, recheck healthy) with SMOKE also slow:
    // the message must report the RECHECK median (the in-budget one), never the slow
    // first batch beside the words "inside the budget".
    const realBlip = await measureLatency(fakeRun([SLOW, HEALTHY]).deps);
    eq(realBlip.kind, "passing-blip", "the real run recovered on recheck");
    const d = decideDualLatency(realBlip, smokeSlow, "100");
    eq(d.page, false, "a recovered real bucket with a SMOKE blip does not page");
    // The real part reports the RECHECK median (48ms), not the slow first batch (835ms).
    assert(
      d.message !== null && /real bucket 100 median 48ms is inside the budget/.test(d.message),
      `names the healthy recheck median as the in-budget one (${d.message})`,
    );
    assert(
      d.message !== null && !/median 835ms is inside the budget/.test(d.message),
      "never the slow first batch claimed as 'inside the budget'",
    );
  }
  {
    // The real bucket measured nothing (a bad/renamed bucket code, or the endpoint
    // did not answer): not a page here, and NOT a measured verdict, so the heartbeat
    // goes stale and pages through the #1700 net rather than reading as healthy. The
    // log still names the real bucket, so a reader knows which probe went quiet.
    const d = decideDualLatency(realNotMeasured, smokeHealthy, "100");
    eq(d.page, false, "a real bucket that measured nothing does not page on this pass");
    eq(d.measured, false, "and does not stamp, so a stuck real probe goes stale (#1700, L557)");
    assert(d.message !== null && /real bucket 100/.test(d.message), `and names the real bucket (${d.message})`);
  }
}

// --- #3653: the page says what the cache did, from what the responses said ------
//
// On 2026-10-12 at 10:50 PM ET the page told the reader to "look for a read that has
// stopped being served from the cache", and the Worker's logs showed 8 of bucket 100's
// 10 reads were `slot_cache="hit"`. The check never looked: every availability response
// carries `x-slot-cache`, and `sample()` threw it away. So each sample now carries what
// the response said, and the cause sentence is built only from that.
const s = (ms: number, cache: LatencySample["cache"], server: LatencySample["server"] = null): LatencySample => ({
  ms,
  cache,
  server,
});
const w = (workerMs: number, limitMs: number | null = null, slotsMs: number | null = null) => ({
  workerMs,
  limitMs,
  slotsMs,
});

// --- reading the two headers ----------------------------------------------------
eq(readSlotCache("hit"), "hit", "x-slot-cache hit");
eq(readSlotCache("miss"), "miss", "x-slot-cache miss (the stored row answered)");
eq(readSlotCache("nostore"), "nostore", "x-slot-cache nostore (computed live)");
eq(readSlotCache(" HIT "), "hit", "read case and whitespace tolerantly");
eq(readSlotCache(null), null, "an absent header is unknown, never a guessed hit");
eq(readSlotCache("stale"), null, "a value the route never sends is unknown too");

{
  // The route's own shape (src/lib/api/server-timing.ts, round tripped in
  // scripts/test-server-timing.ts).
  const t = parseServerTiming("limit;dur=40, slots;dur=12, worker;dur=60");
  eq(t, { workerMs: 60, limitMs: 40, slotsMs: 12 }, "reads the Worker total and both spans");
}
{
  // Cloudflare can add entries of its own, with a quoted desc that may hold a comma.
  // Only the names the route writes are read, and a comma inside quotes splits nothing.
  const t = parseServerTiming('cfL4;desc="?proto=TCP&rtt=21,x=1", worker;dur=7.5');
  eq(t, { workerMs: 7.5, limitMs: null, slotsMs: null }, "ignores foreign entries and quoted commas");
}
eq(parseServerTiming(null), null, "no header is null, so it reads as not measured rather than 0ms");
eq(parseServerTiming("cfL4;desc=\"x\""), null, "a header with none of the route's entries is null too");
eq(parseServerTiming("worker;dur=abc"), null, "an unreadable duration is not a number of milliseconds (L50)");
eq(parseServerTiming("worker;dur=-3"), null, "nor is a negative one");

// --- classifying the reads over budget -------------------------------------------
{
  // The shape of the 2026-10-12 page: split, fast and slow reads in one batch, and
  // the slow ones cache hits. The check classifies only the reads OVER budget, because
  // a fast hit says nothing about where a slow read's time went.
  const kept = [s(1112, "hit"), s(145, "hit"), s(1218, "hit"), s(376, "hit"), s(1052, "hit"), s(3367, "miss")];
  const c = classifySlowReads(kept, AVAILABILITY_P50_BUDGET_MS);
  eq(c.kind, "hits", "mostly hits among the slow reads");
  eq([c.over, c.hits, c.rows, c.computed, c.unread], [4, 3, 1, 0, 0], "counts only the reads over budget");
  const cause = latencyCause(kept, AVAILABILITY_P50_BUDGET_MS);
  assert(/3 of 4 reads over budget were edge cache hits/.test(cause), `names the measured split (${cause})`);
  assert(/Worker/.test(cause) && /limiter/.test(cause) && /network/.test(cause), `and points past the cache (${cause})`);
  assert(!/stopped serving/.test(cause), "and does not blame a cache that was serving");
}
{
  const kept = [s(900, "miss"), s(950, "nostore"), s(990, "miss"), s(60, "hit")];
  const c = classifySlowReads(kept, AVAILABILITY_P50_BUDGET_MS);
  eq(c.kind, "misses", "mostly misses among the slow reads");
  const cause = latencyCause(kept, AVAILABILITY_P50_BUDGET_MS);
  assert(/3 of 3 reads over budget were not served from the edge cache/.test(cause), `counts them (${cause})`);
  assert(/2 from the stored row/.test(cause) && /1 computed live/.test(cause), `and says which tier answered (${cause})`);
  assert(/stopped serving/.test(cause), `so it says the cache stopped serving (${cause})`);
}
{
  // No header at all: an older deploy, or something in front stripping it. The one
  // thing the message may say is that it could not tell.
  const kept = [s(900, null), s(950, null), s(990, null)];
  const c = classifySlowReads(kept, AVAILABILITY_P50_BUDGET_MS);
  eq(c.kind, "unknown", "no header is unknown");
  const cause = latencyCause(kept, AVAILABILITY_P50_BUDGET_MS);
  assert(/no x-slot-cache header/.test(cause) && /could not tell/.test(cause), `says so (${cause})`);
  assert(!/stopped serving|were edge cache hits/.test(cause), "and claims neither direction");
}
{
  const kept = [s(900, "hit"), s(950, "miss"), s(990, null), s(800, "hit"), s(700, "miss")];
  const c = classifySlowReads(kept, AVAILABILITY_P50_BUDGET_MS);
  eq(c.kind, "mixed", "an even split, with one unread, is mixed rather than a majority");
  const cause = latencyCause(kept, AVAILABILITY_P50_BUDGET_MS);
  assert(/2 cache hits/.test(cause) && /2 misses/.test(cause) && /1 without the header/.test(cause), `itemises it (${cause})`);
}
{
  // A minority read is not a majority: two hits of five slow reads, the rest unread,
  // must not be worded as "mostly hits".
  const kept = [s(900, "hit"), s(950, "hit"), s(990, null), s(800, null), s(700, null)];
  eq(classifySlowReads(kept, AVAILABILITY_P50_BUDGET_MS).kind, "mixed", "a minority of hits is not 'hits'");
}
{
  eq(
    latencyCause([s(900, "hit")], AVAILABILITY_P50_BUDGET_MS).includes("1 of 1 read over budget was an edge cache hit"),
    true,
    "a single slow read is worded in the singular",
  );
}

// --- the Worker's own time, beside the canary's -----------------------------------
{
  // Worker time near the client wait: the time was spent inside the Worker, and the
  // split names the limiter and the slot read.
  const kept = [s(1100, "hit", w(1050, 990, 20)), s(1200, "hit", w(1150, 1100, 15)), s(1000, "hit", w(960, 900, 30))];
  const cause = latencyCause(kept, AVAILABILITY_P50_BUDGET_MS);
  assert(/Worker's own clock read a median 1050ms of their 1100ms/.test(cause), `compares the medians (${cause})`);
  assert(/burst limiter 990ms/.test(cause) && /slot read 20ms/.test(cause), `and splits it (${cause})`);
  assert(/inside the Worker/.test(cause), `and says where (${cause})`);
}
{
  // Worker time small against a long wait: most of it was outside what the Worker times.
  // The Worker's clock advances only at I/O, so CPU is named as well as transit.
  const kept = [s(1100, "hit", w(40)), s(1200, "hit", w(35)), s(1000, "hit", w(50))];
  const cause = latencyCause(kept, AVAILABILITY_P50_BUDGET_MS);
  assert(/outside it/.test(cause) && /transit/.test(cause) && /CPU/.test(cause), `attributes it honestly (${cause})`);
}
{
  const cause = latencyCause([s(1100, "hit"), s(1200, "hit")], AVAILABILITY_P50_BUDGET_MS);
  assert(/No Server-Timing/.test(cause) && /cannot be told apart/.test(cause), `says the split was not measured (${cause})`);
}

// --- the confirmed page carries the measured cause --------------------------------
{
  const first = [s(50, "hit"), s(900, "hit"), s(900, "hit"), s(900, "hit"), s(100, "hit")];
  const recheck = [s(50, "hit"), s(900, "hit"), s(900, "hit"), s(900, "miss"), s(900, "hit")];
  const sleeps: number[] = [];
  let i = 0;
  const run = await measureLatency({
    takeBatch: async () => [first, recheck][i++] ?? [],
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  eq(run.kind, "confirmed", "slow on both batches");
  assert(
    run.message !== null && /6 of 7 reads over budget were edge cache hits/.test(run.message),
    `the page classifies both batches' slow reads, cold ones dropped (${run.message})`,
  );
  assert(run.message !== null && !/stopped serving/.test(run.message), "and does not blame the cache");
  eq(run.first.kept.length, 4, "the verdict keeps its samples, cold one dropped");
}
{
  // The first batch was slow and the recheck read nothing: the cause is the first
  // batch's, since that is all that was measured.
  let i = 0;
  const run = await measureLatency({
    takeBatch: async () => [[s(1, "miss"), s(900, "miss"), s(900, "miss"), s(900, "miss")], []][i++] ?? [],
    sleep: async () => {},
  });
  eq(run.kind, "recheck-unmeasured", "a recheck that measured nothing");
  assert(run.message !== null && /stopped serving/.test(run.message), `names the first batch's misses (${run.message})`);
  assert(run.message !== null && /answering at all/.test(run.message), "and still asks whether it answers at all");
}

// --- the log line ------------------------------------------------------------------
eq(
  formatSamples([s(1112, "hit", w(95, 80, 10)), s(145, "miss", w(30)), s(300, null)]),
  "1112 hit worker=95(limit=80,slots=10), 145 miss worker=30, 300 nohdr",
  "each sample names its cache outcome and, when sent, the Worker's own time and split",
);
eq(formatSamples([]), "", "an empty batch prints nothing between the brackets");

finish();
