// Pure alert-decision logic for the no-eligible-agents monitor (#327): which
// buckets route to nobody, and the throttled-alert copy for the proactive sweep
// and the reactive (booking-time) signal. Pure so it runs node-native.
// Run: node --experimental-strip-types scripts/test-bucket-coverage.ts
import {
  emptyBuckets,
  emptyBucketAlert,
  noEligibleAgentsAlert,
} from "../src/lib/availability/bucket-coverage.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

// --- emptyBuckets: zero eligible agents = a routing dead zone ---
{
  const cov = [
    { code: "411", eligibleCount: 3 },
    { code: "412", eligibleCount: 0 },
    { code: "511", eligibleCount: 0 },
    { code: "611", eligibleCount: 1 },
  ];
  const empty = emptyBuckets(cov);
  assert(empty.length === 2, "two buckets with zero eligible agents are flagged");
  assert(empty.includes("412") && empty.includes("511"), "the right codes are flagged");
  assert(!empty.includes("411") && !empty.includes("611"), "covered buckets are NOT flagged");
  assert(emptyBuckets([]).length === 0, "no buckets -> nothing flagged");
  assert(
    emptyBuckets([{ code: "x", eligibleCount: 5 }]).length === 0,
    "a fully-covered set flags nothing",
  );
}

// --- emptyBucketAlert: a throttled message only when something is empty ---
{
  assert(
    emptyBucketAlert([{ code: "411", eligibleCount: 2 }]) === null,
    "no empty buckets -> no alert (null)",
  );
  const msg = emptyBucketAlert([
    { code: "412", eligibleCount: 0 },
    { code: "511", eligibleCount: 0 },
  ]);
  assert(msg !== null, "empty buckets -> an alert string");
  assert(!!msg && msg.includes("412") && msg.includes("511"), "alert names the empty buckets");
  assert(!!msg && /slate/i.test(msg), "alert is Slate-branded for the channel");
}

// --- noEligibleAgentsAlert: the reactive (booking hit an empty bucket) copy ---
{
  const withCode = noEligibleAgentsAlert("412");
  assert(withCode.includes("412"), "reactive alert names the bucket that failed");
  assert(/no eligible|no bookable|no advisors/i.test(withCode), "reactive alert explains the cause");
  // Defensive: still produces a sensible message if the code is missing.
  assert(noEligibleAgentsAlert(null).length > 0, "reactive alert tolerates a missing bucket code");
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
