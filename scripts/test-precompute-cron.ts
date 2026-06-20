import {
  orderBucketsForRecompute,
  staleBuckets,
  bucketsDueForRecompute,
  recomputeHeadroom,
} from "../src/lib/availability/precompute-cron.ts";

let failures = 0;
const assert = (c: boolean, m: string) => { if (!c) { console.error("FAIL:", m); failures++; } else console.log("ok:", m); };

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

// recomputeHeadroom: early-warning that the lane is approaching its limit,
// BEFORE buckets actually go stale. Warn if it couldn't drain the due set, or
// if it used >= warnFraction of its per-tick budget.
const B = 50_000;
const healthy = recomputeHeadroom(16_000, B, 15, 15, 0.7);
assert(healthy.warn === false, "healthy run (32% budget, fully drained) does not warn");
assert(healthy.utilizationPct === 32, "utilization is run/budget as a percent");
assert(healthy.drained === true, "drained when it recomputed all due buckets");

const hot = recomputeHeadroom(40_000, B, 20, 20, 0.7);
assert(hot.warn === true, "warns at high utilization (80%) even if drained");

const behind = recomputeHeadroom(50_000, B, 40, 30, 0.7);
assert(behind.drained === false && behind.warn === true, "warns when the due set wasn't drained");

const edge = recomputeHeadroom(35_000, B, 10, 10, 0.7);
assert(edge.warn === true, "warns at exactly the warn fraction (70%)");

const empty = recomputeHeadroom(200, B, 0, 0, 0.7);
assert(empty.warn === false && empty.drained === true, "nothing due is healthy, not a warning");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
