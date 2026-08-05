import {
  orderBucketsForRecompute,
  staleBuckets,
  bucketsDueForRecompute,
  recomputeHeadroom,
  recomputeDueBuckets,
  staleBucketPage,
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

// bucketsDueForRecompute (#294): only buckets older than the freshness window
// (or never computed), oldest-first — so the cron stops re-deriving every bucket
// every minute and just covers the day-window slide + missed-push backstop.
const due = bucketsDueForRecompute(known, allCodes, now, 90_000);
assert(JSON.stringify(due) === JSON.stringify(["400", "200", "100"]),
  `never-computed (400) first, then oldest-first (200,100); fresh 300 excluded; got ${JSON.stringify(due)}`);
assert(!due.includes("300"), "a bucket within the freshness window is NOT recomputed");

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

  // No invalidation in flight: unchanged behaviour, stale pages immediately.
  const organic = staleBucketPage(62, null, now, GRACE);
  assert(organic.page === true, "stale buckets page when no invalidation explains them");

  // A save 30 seconds ago: the drain is in flight, so no page.
  const draining = staleBucketPage(62, now - 30_000, now, GRACE);
  assert(draining.page === false, "a deliberate invalidation 30s ago does not page");
  assert(
    /invalidation|deliberate|save/i.test(draining.reason),
    "the no-page decision says WHY it is not paging, for the log",
  );

  // Same staleness, past the grace: the drain genuinely failed, so it pages.
  const stuck = staleBucketPage(62, now - GRACE - 1, now, GRACE);
  assert(stuck.page === true, "still stale past the grace window pages for real");

  // Nothing stale: nothing to say either way, and the grace is irrelevant.
  assert(staleBucketPage(0, now - 30_000, now, GRACE).page === false, "no stale buckets, no page");
  assert(staleBucketPage(0, null, now, GRACE).page === false, "no stale buckets and no marker, no page");

  // Exactly at the boundary counts as expired: the grace is the budget, and a
  // drain that used all of it and is still behind has not met it.
  assert(staleBucketPage(1, now - GRACE, now, GRACE).page === true, "at the grace boundary it pages");

  // An unreadable marker must not become an open-ended silence. NaN is what a
  // corrupt stored stamp parses to, and every comparison against it is false, so
  // it has to land on the PAGE side rather than the quiet side (the #1169 class).
  assert(staleBucketPage(62, Number.NaN, now, GRACE).page === true, "an unreadable marker pages");

  // A marker stamped in the FUTURE (a clock skew, or a bad write) must not buy
  // unlimited grace either.
  assert(
    staleBucketPage(62, now + 60_000, now, GRACE).page === true,
    "a marker in the future does not grant grace",
  );
}

finish();
