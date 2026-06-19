import {
  orderBucketsForRecompute,
  staleBuckets,
  bucketsDueForRecompute,
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

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
