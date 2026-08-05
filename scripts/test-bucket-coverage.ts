// Pure alert-decision logic for the no-eligible-agents monitor (#327): which
// buckets route to nobody, and the throttled-alert copy for the proactive sweep
// and the reactive (booking-time) signal. Pure so it runs node-native.
// Run: node --experimental-strip-types scripts/test-bucket-coverage.ts
import {
  emptyBuckets,
  emptyBucketMessage,
  noEligibleAgentsAlert,
  planEmptyBucketAlerts,
  emptyBucketsAggregateMessage,
  emptyBucketsAggregateRecoveredMessage,
  AGGREGATE_EMPTY_THRESHOLD,
  AGGREGATE_BUCKET_CODE,
} from "../src/lib/availability/bucket-coverage.ts";
import { assert, finish } from "./lib/harness.ts";

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
  // No leading "Slate" label: the Slack app name and icon already say who is
  // speaking, so the line opens with what is wrong.
  assert(!/^\s*Slate\b/i.test(msg), "proactive message does not open with a Slate label");
}

// --- noEligibleAgentsAlert: the reactive (booking hit an empty bucket) copy ---
{
  const withCode = noEligibleAgentsAlert("412");
  assert(withCode.includes("412"), "reactive alert names the bucket that failed");
  assert(/no eligible|no bookable|no advisors/i.test(withCode), "reactive alert explains the cause");
  // Defensive: still produces a sensible message if the code is missing.
  assert(noEligibleAgentsAlert(null).length > 0, "reactive alert tolerates a missing bucket code");
}

// --- planEmptyBucketAlerts: one page for a systemic cause, not sixty ---
//
// The per-bucket key was chosen so two dead zones never suppress each other, and
// that is right for two. It has no ceiling, so when the cause is ONE shared thing
// (nobody in the roster is bookable) it pages once per bucket: 60 messages a wave,
// every wave, saying the same thing. Above a threshold the sweep folds them into
// a single page that names the count and the cause (L36: aggregate during a broad
// outage), and the individual pages are settled WITHOUT posting 60 all-clears.
{
  const cov = (empty: number, healthy: number) => [
    ...Array.from({ length: empty }, (_, i) => ({ code: `e${i}`, eligibleCount: 0 })),
    ...Array.from({ length: healthy }, (_, i) => ({ code: `h${i}`, eligibleCount: 4 })),
  ];

  // Below the threshold: today's behaviour, one page per dead bucket.
  const few = planEmptyBucketAlerts(cov(2, 8));
  assert(few.aggregated === false, "two dead buckets stay per-bucket pages");
  assert(few.pageCodes.length === 2, "each of the two is paged on its own key");
  assert(few.settleCodes.length === 0, "nothing is settled silently in per-bucket mode");
  assert(few.clearCodes.length === 8, "the eight healthy buckets may be cleared");

  // At the threshold: one page for the set.
  const many = planEmptyBucketAlerts(cov(AGGREGATE_EMPTY_THRESHOLD, 5));
  assert(many.aggregated === true, "the threshold number of dead buckets aggregates");
  assert(many.pageCodes.length === 0, "aggregated mode sends no per-bucket page");
  assert(
    many.settleCodes.length === AGGREGATE_EMPTY_THRESHOLD,
    "every dead bucket's own page is settled silently, so switching modes posts no flood",
  );
  assert(many.clearCodes.length === 5, "healthy buckets are still cleared normally");

  // Every bucket dead is systemic at any roster size, even below the threshold.
  const allDead = planEmptyBucketAlerts(cov(3, 0));
  assert(allDead.aggregated === true, "every bucket dead aggregates even under the threshold");

  // A single-bucket org is not a broad outage; one page is already one page.
  const lone = planEmptyBucketAlerts(cov(1, 0));
  assert(lone.aggregated === false, "one bucket, dead, is not an aggregate");
  assert(lone.pageCodes.length === 1, "the lone dead bucket still pages");

  // Nothing dead: no pages either way, everything clearable.
  const none = planEmptyBucketAlerts(cov(0, 4));
  assert(none.aggregated === false && none.pageCodes.length === 0, "a healthy sweep pages nothing");
  assert(none.clearCodes.length === 4, "a healthy sweep may clear every bucket");

  // The aggregate rides a key that no bucket code can collide with (codes are the
  // 3-digit XBC codes), so it cannot clear or suppress a real bucket's page.
  assert(!/^\d+$/.test(AGGREGATE_BUCKET_CODE), "the aggregate key is not shaped like a bucket code");
}

// --- emptyBucketsAggregateMessage: says how many, and names the cause it MEASURED ---
{
  const systemic = emptyBucketsAggregateMessage(60, 60, 0);
  assert(systemic.includes("60"), "the aggregate page says how many buckets are dead");
  assert(
    /no agent|nobody/i.test(systemic),
    "with zero bookable agents it names that as the shared cause",
  );
  assert(!/^\s*Slate\b/i.test(systemic), "the aggregate page does not open with a Slate label");

  // Agents ARE bookable, so the cause is per-bucket config, not the roster: the
  // page must not blame the roster.
  const partial = emptyBucketsAggregateMessage(12, 60, 40);
  assert(partial.includes("12") && partial.includes("60"), "it says how many of how many");
  assert(/40/.test(partial), "it reports the bookable agent count it measured");
  assert(
    !/no agent is bookable|nobody is bookable/i.test(partial),
    "it does not claim an empty roster when 40 agents are bookable",
  );
  assert(/1 agent is bookable/.test(emptyBucketsAggregateMessage(9, 60, 1)), "singular reads right");

  // Unreadable count: claim only what was measured (L11). No invented cause.
  const unknown = emptyBucketsAggregateMessage(60, 60, null);
  assert(unknown.includes("60"), "an unreadable agent count still reports the bucket count");
  assert(
    /could not be read|not established|unknown/i.test(unknown),
    "an unreadable agent count is stated as unreadable, never scored as zero",
  );
  assert(
    !/no agent is bookable|nobody is bookable/i.test(unknown),
    "an unreadable count never presents as an empty roster",
  );
}

// --- emptyBucketsAggregateRecoveredMessage: honest about what is left ---
{
  const full = emptyBucketsAggregateRecoveredMessage(0, 60);
  assert(/again|cleared/i.test(full), "a full recovery says the condition is over");
  assert(!/still/i.test(full), "a full recovery does not imply leftovers");

  // Dropping below the threshold ends the AGGREGATE, but three buckets are still
  // dead and are about to page on their own: the all-clear must not read as
  // "everything is fine".
  const partial = emptyBucketsAggregateRecoveredMessage(3, 60);
  assert(partial.includes("3"), "a partial recovery says how many are still dead");
  assert(/still/i.test(partial), "a partial recovery says some buckets remain dead");
  assert(!/^\s*Slate\b/i.test(partial), "the all-clear does not open with a Slate label");
}

finish();
