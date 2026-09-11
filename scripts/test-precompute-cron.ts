import {
  orderBucketsForRecompute,
  staleBuckets,
  bucketsDueForRecompute,
  bucketDueAtMs,
  RECOMPUTE_FRESH_MS,
  RECOMPUTE_JITTER_FRACTION,
  STALE_ALARM_MS,
  recomputeHeadroom,
  recomputeDueBuckets,
  staleBucketPage,
  INVALIDATION_UNREADABLE_TOLERANCE,
  INVALIDATION_UNREADABLE_WINDOW_S,
  type InvalidationMarker,
} from "../src/lib/availability/precompute-cron.ts";
import { assert, finish } from "./lib/harness.ts";

const allCodes = ["100", "200", "300", "400"];
const known = [
  { code: "100", computedAtMs: 5000 },
  { code: "200", computedAtMs: 1000 }, // oldest computed
  { code: "300", computedAtMs: 50000 }, // freshest
  // 400 never computed
];

// Touched first (in order), then remaining by computedAt asc with never-computed first.
const order = orderBucketsForRecompute(["300"], known, allCodes);
assert(order[0] === "300", "touched bucket goes first even though it is freshest");
assert(JSON.stringify(order) === JSON.stringify(["300", "400", "200", "100"]),
  `then never-computed (400), then oldest-first (200,100); got ${JSON.stringify(order)}`);

// No duplicates when a touched bucket is also in allCodes.
assert(new Set(order).size === order.length, "no duplicate codes in the order");

// Stale = never-computed OR older than the budget.
const now = 100_000;
const stale = staleBuckets(known, allCodes, now, 90_000).sort();
assert(JSON.stringify(stale) === JSON.stringify(["100", "200", "400"]),
  `100/200 are >90s old and 400 never computed; 300 is fresh; got ${JSON.stringify(stale)}`);

// bucketsDueForRecompute (#294): only buckets past their own deadline (or never
// computed), oldest-first, so the cron stops re-deriving every bucket every minute
// and just covers the day-window slide plus the missed-push backstop.
//
// With the deadlines spread (#1247) the guarantee is stated as a FRACTION rather
// than the whole window: a bucket is never recomputed within the remaining quarter
// of its window, and never held longer than the full window. Both bounds are
// asserted per bucket further down. Here the ORDER is what matters, so the jitter
// is switched off to keep the fixture about ordering rather than about phases.
const due = bucketsDueForRecompute(known, allCodes, now, 90_000, 0);
assert(JSON.stringify(due) === JSON.stringify(["400", "200", "100"]),
  `never-computed (400) first, then oldest-first (200,100); fresh 300 excluded; got ${JSON.stringify(due)}`);
assert(!due.includes("300"), "with no jitter, a bucket within the freshness window is NOT recomputed");

// And with the jitter ON, a bucket inside the FLOOR is still never recomputed:
// that is the part of #294's guarantee the spreading keeps.
assert(
  bucketsDueForRecompute([{ code: "300", computedAtMs: now - 10_000 }], ["300"], now, 90_000).length === 0,
  "a bucket computed 10s ago is inside the floor of a 90s window, so it is not recomputed however its phase falls",
);

// A wider freshness window leaves nothing due (everything is 'fresh enough').
assert(
  bucketsDueForRecompute([{ code: "a", computedAtMs: 99_000 }], ["a"], now, 90_000).length === 0,
  "a bucket computed 1s ago is not due under a 90s window",
);
// Never-computed is always due regardless of window.
assert(
  JSON.stringify(bucketsDueForRecompute([], ["z"], now, 90_000)) === JSON.stringify(["z"]),
  "a never-computed bucket is always due",
);

// recomputeHeadroom: a cycle only "warns" when it could NOT drain the due set
// within budget (the lane is genuinely behind). Finishing all due work is
// keeping up, period — even a 98% cycle does NOT warn (it would only be noise,
// since nothing went stale). The route adds a consecutive-cycle streak on top
// so a one-off busy cycle (e.g. a post-deploy catch-up) stays silent.
const B = 50_000;
const healthy = recomputeHeadroom(16_000, B, 15, 15);
assert(healthy.warn === false, "healthy run (32% budget, fully drained) does not warn");
assert(healthy.utilizationPct === 32, "utilization is run/budget as a percent");
assert(healthy.drained === true, "drained when it recomputed all due buckets");

// The exact case that paged in prod: 98% of budget but fully drained (20/20).
// Keeping up == no warning, no matter how close to the budget it ran. (The old
// signature took a warnFraction; pass it to prove it's now ignored for a
// drained cycle rather than silently dropped.)
const hot = recomputeHeadroom(49_000, B, 20, 20);
assert(hot.drained === true, "a 98% cycle that finished all due work IS drained");
assert(hot.warn === false, "a fully-drained cycle never warns, even near the budget");

const behind = recomputeHeadroom(50_000, B, 40, 30);
assert(behind.drained === false && behind.warn === true, "warns ONLY when the due set wasn't drained");

const empty = recomputeHeadroom(200, B, 0, 0);
assert(empty.warn === false && empty.drained === true, "nothing due is healthy, not a warning");

// recomputeDueBuckets: drain the due set in BOUNDED-CONCURRENCY waves within a
// time budget, so the lane keeps up at fleet scale (#297 follow-up) instead of
// the old one-at-a-time loop that fell ~1 bucket behind per cycle at ~110 agents.
await (async () => {
  // Drains everything when budget allows, and actually runs concurrently up to
  // the limit (never beyond it).
  let inFlight = 0;
  let maxInFlight = 0;
  const recomputed = await recomputeDueBuckets(
    ["a", "b", "c", "d", "e", "f", "g"],
    async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 0));
      inFlight--;
    },
    () => true,
    3,
  );
  assert(recomputed === 7, `drains all due buckets when in budget (got ${recomputed})`);
  assert(maxInFlight === 3, `runs concurrently up to the limit and no further (max ${maxInFlight})`);
})();

await (async () => {
  // Stops launching new waves once the budget is exhausted (budget true for the
  // first wave only -> only the first wave runs).
  let allow = true;
  let calls = 0;
  const recomputed = await recomputeDueBuckets(
    ["a", "b", "c", "d", "e", "f"],
    async () => {
      calls++;
    },
    () => {
      const a = allow;
      allow = false;
      return a;
    },
    3,
  );
  assert(recomputed === 3 && calls === 3, `stops when the budget is gone (got ${recomputed}/${calls})`);
})();

await (async () => {
  // A failing bucket is isolated: it isn't counted, but the others still are.
  const recomputed = await recomputeDueBuckets(
    ["ok1", "bad", "ok2"],
    async (code) => {
      if (code === "bad") throw new Error("boom");
    },
    () => true,
    3,
  );
  assert(recomputed === 2, `a failing bucket is isolated; others still recompute (got ${recomputed})`);
})();

await (async () => {
  // #2237 follow-up: a unit of work can stand for SEVERAL things (a pool of six
  // bucket codes), so the drain sums what each unit reports rather than counting
  // units. The caller must not accumulate this itself: `total += await f()` reads
  // `total` BEFORE it awaits, so several units running concurrently each add to
  // the value they saw at the start and the last one to settle wins. That shipped
  // and reported one pool's worth of writes as the whole cycle, which made the
  // lane judge itself behind on every tick and put a false page five cycles out.
  const perUnit = new Map([["a", 6], ["b", 3], ["c", 3], ["d", 6], ["e", 6], ["f", 3]]);
  const total = await recomputeDueBuckets(
    [...perUnit.keys()],
    async (unit) => {
      // An await BEFORE the return, so every unit is genuinely in flight at once:
      // without it the additions serialise and the lost update cannot appear.
      await new Promise((r) => setTimeout(r, 0));
      return perUnit.get(unit)!;
    },
    () => true,
    6,
    (u) => u,
  );
  assert(total === 27, `sums what each unit reported, not the unit count (got ${total})`);
})();

await (async () => {
  // A unit that reports NOTHING still counts as one, which is what every caller
  // before pooling meant and what the three cases above rely on.
  const total = await recomputeDueBuckets(["a", "b"], async () => {}, () => true, 2);
  assert(total === 2, `a unit that reports no number counts as one (got ${total})`);
})();

await (async () => {
  // And a unit that reports a number while a sibling THROWS: the thrower adds
  // nothing and the reporter still adds its own.
  const total = await recomputeDueBuckets(
    ["ok", "bad"],
    async (u) => {
      await new Promise((r) => setTimeout(r, 0));
      if (u === "bad") throw new Error("boom");
      return 6;
    },
    () => true,
    2,
  );
  assert(total === 6, `a failing unit contributes nothing and the other still counts (got ${total})`);
})();

// --- staleBucketPage: a deliberate invalidation is not a fall-behind (#1301) ---
//
// Saving a booking setting marks EVERY bucket's slots stale on purpose, so the
// next recompute rebuilds them over the new window. The stale alarm then sees 60+
// buckets past its 6 minute threshold and pages about a condition the save itself
// created, and the lane cannot drain 60 buckets in the ~2 minutes between the
// freshness window and the alarm. That page has never fired only because no
// booking setting has ever been saved in production.
//
// The fix is a BOUNDED grace, not a suppression: staleness attributable to a
// recent deliberate invalidation does not page, and the same staleness DOES page
// once the grace expires, because a drain that has not finished by then is the
// genuine fall-behind the alarm exists for.
{
  const GRACE = 15 * 60_000;
  const now = 1_800_000_000_000;

  /** The marker as the reader hands it over, absent unless said otherwise. */
  const marker = (over: Partial<InvalidationMarker> = {}): InvalidationMarker =>
    ({ state: "absent", ...over }) as InvalidationMarker;

  // No invalidation in flight: unchanged behaviour, stale pages immediately.
  const organic = staleBucketPage(62, marker(), now, GRACE, false);
  assert(organic.page === true, "stale buckets page when no invalidation explains them");

  // A save 30 seconds ago: the drain is in flight, so no page.
  const draining = staleBucketPage(62, marker({ state: "at", atMs: now - 30_000 }), now, GRACE, false);
  assert(draining.page === false, "a deliberate invalidation 30s ago does not page");
  assert(
    /invalidation|deliberate|save/i.test(draining.reason),
    "the no-page decision says WHY it is not paging, for the log",
  );

  // Same staleness, past the grace: the drain genuinely failed, so it pages.
  const stuck = staleBucketPage(62, marker({ state: "at", atMs: now - GRACE - 1 }), now, GRACE, false);
  assert(stuck.page === true, "still stale past the grace window pages for real");

  // Nothing stale: nothing to say either way, and the grace is irrelevant.
  assert(
    staleBucketPage(0, marker({ state: "at", atMs: now - 30_000 }), now, GRACE, false).page === false,
    "no stale buckets, no page",
  );
  assert(staleBucketPage(0, marker(), now, GRACE, false).page === false, "no stale buckets and no marker, no page");

  // Exactly at the boundary counts as expired: the grace is the budget, and a
  // drain that used all of it and is still behind has not met it.
  assert(
    staleBucketPage(1, marker({ state: "at", atMs: now - GRACE }), now, GRACE, false).page === true,
    "at the grace boundary it pages",
  );

  // A marker stamped in the FUTURE (a clock skew, or a bad write) must not buy
  // unlimited grace either.
  assert(
    staleBucketPage(62, marker({ state: "at", atMs: now + 60_000 }), now, GRACE, false).page === true,
    "a marker in the future does not grant grace",
  );
}

// --- an UNREADABLE marker rides out a few ticks before paging (#1304) ---
//
// Dan (2026-08-05): when the marker cannot be read the alarm should "retry and
// page only after three consecutive failures", so a transient database blip does
// not wake anyone. #1301 chose to page at once precisely so the alarm never went
// quiet on a value it could not check, and that instinct is right; what it lacked
// was the difference between one blip and a marker that has been unreadable for
// three minutes running.
//
// The distinction every assertion below turns on: UNREADABLE is not ABSENT.
// Absent is the normal state, meaning nobody invalidated anything, and it must
// keep paging on the first tick. Only a failed read gets the tolerance.
{
  const GRACE = 15 * 60_000;
  const now = 1_800_000_000_000;
  const TOLERANCE = 3;

  const unreadable = (toleranceReached: boolean) =>
    staleBucketPage(62, { state: "unreadable" }, now, GRACE, toleranceReached, TOLERANCE);

  assert(unreadable(false).page === false, "an unreadable tick under the tolerance rides it out");
  assert(unreadable(true).page === true, "and pages once the tolerance is reached");
  assert(
    /read|unreadable/i.test(unreadable(true).reason),
    "the page says the marker could not be READ, not that a drain fell behind",
  );
  assert(
    /3/.test(unreadable(true).reason),
    "and how many consecutive ticks, so the reader knows how long it has been blind",
  );
  assert(
    /wait/i.test(unreadable(false).reason),
    "the quiet decision says it is waiting rather than that all is well, for the log",
  );
  assert(
    /3/.test(unreadable(false).reason),
    "and how many it is waiting for, so a log reader is not left guessing",
  );

  // The tolerance is ONLY for the unreadable case. An absent marker is the normal
  // "nobody invalidated anything" state, so it must never inherit this delay: the
  // alarm this lane exists for would be three minutes late every time it mattered.
  assert(
    staleBucketPage(62, { state: "absent" }, now, GRACE, false, TOLERANCE).page === true,
    "an ABSENT marker still pages on the first tick, whatever the unreadable streak says",
  );
  assert(
    staleBucketPage(62, { state: "at", atMs: now + 60_000 }, now, GRACE, false, TOLERANCE).page === true,
    "a future marker still pages on the first tick too",
  );
  assert(
    staleBucketPage(62, { state: "at", atMs: now - GRACE - 1 }, now, GRACE, false, TOLERANCE).page === true,
    "a drain past its grace still pages on the first tick too",
  );
  // And nothing stale still says nothing, even while the marker is unreadable:
  // there is no condition to report.
  assert(
    staleBucketPage(0, { state: "unreadable" }, now, GRACE, true, TOLERANCE).page === false,
    "no stale buckets means no page however long the marker has been unreadable",
  );
}

// --- the streak WINDOW has to outlast the ticks it is counting (#1304) --------
//
// The streak is counted in a rate-limit window, so if the window is shorter than
// the ticks it must span, three genuinely consecutive failures land in different
// windows and the third is counted as a first. The alarm would then never fire, and
// it would look exactly like a marker that kept recovering.
{
  const lanePeriodMs = 60_000; // the recompute lane is every minute
  const spanNeeded = (INVALIDATION_UNREADABLE_TOLERANCE - 1) * lanePeriodMs;
  assert(
    INVALIDATION_UNREADABLE_WINDOW_S * 1000 > spanNeeded,
    `the streak window (${INVALIDATION_UNREADABLE_WINDOW_S}s) outlasts the ${INVALIDATION_UNREADABLE_TOLERANCE} ` +
      `every-minute ticks it must span (${spanNeeded / 1000}s), or consecutive failures land in different windows`,
  );
  assert(
    INVALIDATION_UNREADABLE_TOLERANCE === 3,
    "three consecutive failures, which is what was asked for",
  );
}

// --- jittered deadlines, so the due set stops arriving in clumps (#1247) ------
//
// Buckets recomputed in the same cycle all age past a FIXED window in the same
// later cycle, so the due set bunches instead of spreading. Live timestamps showed
// 5, 6, 8, 15 then 22 buckets refreshed in consecutive minutes rather than a
// steady 15, with the due set at p50 7, p90 24, max 35. That was harmless while a
// bucket took 700ms; it is what converts a per bucket cost increase into a cycle
// that cannot drain within its budget.
//
// The direction of the jitter is the safety property. It only ever makes a bucket
// due EARLIER, never later, so no bucket can be pushed closer to the staleness
// alarm and freshness strictly improves. The cost is a shorter average window,
// which is stated and bounded rather than hidden.
{
  const CODES = Array.from({ length: 62 }, (_, i) => String(100 + i));
  const FRESH = 4 * 60_000;
  const T0 = 1_800_000_000_000;

  // Stable: the same code must always get the same offset, or the rotation
  // reshuffles every tick and never levels.
  const a = bucketsDueForRecompute([{ code: "101", computedAtMs: T0 }], ["101"], T0 + FRESH - 30_000, FRESH);
  const b = bucketsDueForRecompute([{ code: "101", computedAtMs: T0 }], ["101"], T0 + FRESH - 30_000, FRESH);
  assert(
    JSON.stringify(a) === JSON.stringify(b),
    "the jitter is stable for a given bucket code, so the rotation levels instead of reshuffling",
  );

  // Never LATER than the plain window: at exactly freshMs every bucket is due,
  // whatever its offset, so the jitter can never delay a refresh.
  const allDue = bucketsDueForRecompute(
    CODES.map((code) => ({ code, computedAtMs: T0 })),
    CODES,
    T0 + FRESH + 1,
    FRESH,
  );
  assert(
    allDue.length === CODES.length,
    `every bucket is due by the plain freshness window (${allDue.length} of ${CODES.length}); the jitter must only ever pull a deadline EARLIER`,
  );

  // The headline: all 62 computed in one cycle, then stepped minute by minute.
  // Without jitter every one of them lands in a single tick.
  const perTick: number[] = [];
  const computedAt = new Map(CODES.map((c) => [c, T0]));
  for (let tick = 1; tick <= 12; tick += 1) {
    const nowMs = T0 + tick * 60_000;
    const dueNow = bucketsDueForRecompute(
      CODES.map((code) => ({ code, computedAtMs: computedAt.get(code)! })),
      CODES,
      nowMs,
      FRESH,
    );
    perTick.push(dueNow.length);
    for (const code of dueNow) computedAt.set(code, nowMs);
  }
  const peak = Math.max(...perTick);
  assert(
    peak < CODES.length,
    `the due set never arrives as one clump of all ${CODES.length} (peak was ${peak}, per tick: ${perTick.join(",")})`,
  );
  assert(
    peak <= Math.ceil(CODES.length / 2),
    `and the peak stays well under half the ladder (peak ${peak} of ${CODES.length}, per tick: ${perTick.join(",")})`,
  );
  // The grid, not a shortened window: total work over 12 ticks must stay close to
  // what a plain 4-minute window would do (62 buckets x 12 min / 4 min = 186), or
  // the spreading has been bought with permanently more recomputes.
  const total = perTick.reduce((x, y) => x + y, 0);
  assert(
    total <= 186 * 1.25,
    `spreading does not cost permanently more work (${total} recomputes over 12 ticks against about 186 for a plain window)`,
  );
  // Every bucket must still get refreshed: a spread that starves one is worse
  // than a clump.
  const oldest = Math.max(...CODES.map((c) => T0 + 12 * 60_000 - computedAt.get(c)!));
  assert(
    oldest <= FRESH,
    `no bucket is starved by the spreading (oldest went ${Math.round(oldest / 1000)}s without a refresh)`,
  );
}
{
  // A never-computed bucket has no timestamp to jitter and must be due at once:
  // it is showing NO availability until it is built.
  const out = bucketsDueForRecompute([], ["101", "202"], 1_800_000_000_000, 4 * 60_000);
  assert(out.length === 2, "a never-computed bucket is due immediately, jitter or not");
}
{
  // The jitter has to stay clear of the staleness alarm, which is what stops the
  // spreading from manufacturing the very page the freshness window exists under.
  // The gap from one due point to the next is always inside the plain window, so
  // no bucket is ever held longer than it would have been and the spreading cannot
  // push anything closer to the alarm.
  const floorMs = RECOMPUTE_FRESH_MS * (1 - RECOMPUTE_JITTER_FRACTION);
  for (const code of ["100", "411", "999", "612", "205", "318"]) {
    const at = 1_800_000_000_000 + 12_345;
    const gap = bucketDueAtMs(code, at, RECOMPUTE_FRESH_MS) - at;
    assert(
      gap <= RECOMPUTE_FRESH_MS,
      `bucket ${code} is never held LONGER than the plain window (gap ${gap}ms), so the spreading cannot push it toward the alarm`,
    );
    assert(
      gap >= floorMs,
      `and never recomputed within the remaining quarter of its window (bucket ${code} gap ${gap}ms, floor ${floorMs}ms): recomputing a bucket that fresh is the waste #294 removed`,
    );
  }
  assert(
    RECOMPUTE_FRESH_MS < STALE_ALARM_MS,
    "and the window still sits below the alarm, since the jitter only pulls deadlines earlier",
  );
}

finish();
