// Pure alert-decision logic for the no-eligible-agents monitor (#327): which
// buckets route to nobody, and the throttled-alert copy for the proactive sweep
// and the reactive (booking-time) signal. Pure so it runs node-native.
// Run: node --experimental-strip-types scripts/test-bucket-coverage.ts
import {
  emptyBuckets,
  emptyBucketMessage,
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

// --- emptyBucketMessage: per-bucket proactive copy (one alert per dead bucket,
// so simultaneous dead zones each surface under their own throttle) ---
{
  const msg = emptyBucketMessage("412");
  assert(msg.includes("412"), "proactive message names the specific bucket");
  assert(/no eligible|no bookable|no advisors/i.test(msg), "proactive message explains the cause");
  assert(/slate/i.test(msg), "proactive message is Slate-branded for the channel");
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
