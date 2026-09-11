// Pure alert-decision logic for the no-eligible-agents monitor (#327): which
// buckets route to nobody, and the throttled-alert copy for the proactive sweep
// and the reactive (booking-time) signal. Pure so it runs node-native.
// Run: node --experimental-strip-types scripts/test-bucket-coverage.ts
import {
  emptyBuckets,
  emptyPools,
  emptyBucketMessage,
  noEligibleAgentsAlert,
  planEmptyBucketAlerts,
  emptyBucketsAggregateMessage,
  emptyBucketsAggregateRecoveredMessage,
  AGGREGATE_EMPTY_THRESHOLD,
  AGGREGATE_BUCKET_CODE,
} from "../src/lib/availability/bucket-coverage.ts";
import { bookerUnstaffedAlert } from "../src/lib/booking/alert-copy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** A bucket in a pool of its own, which is what every case below the pool
 *  section was written against. */
const alone = (code: string, eligibleCount: number) => ({
  code,
  eligibleCount,
  poolKey: `pool-${code}`,
  poolLabel: null,
});

// --- emptyBuckets: zero eligible agents = a routing dead zone ---
{
  const cov = [
    alone("411", 3),
    alone("412", 0),
    alone("511", 0),
    alone("611", 1),
  ];
  const empty = emptyBuckets(cov);
  assert(empty.length === 2, "two buckets with zero eligible agents are flagged");
  assert(empty.includes("412") && empty.includes("511"), "the right codes are flagged");
  assert(!empty.includes("411") && !empty.includes("611"), "covered buckets are NOT flagged");
  assert(emptyBuckets([]).length === 0, "no buckets -> nothing flagged");
  assert(
    emptyBuckets([alone("x", 5)]).length === 0,
    "a fully-covered set flags nothing",
  );
}

// --- emptyBucketMessage: per-bucket proactive copy (one alert per dead bucket,
// so simultaneous dead zones each surface under their own throttle) ---
{
  const msg = emptyBucketMessage({
    key: "k", label: null, codes: ["412"], representative: "412",
  });
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
    ...Array.from({ length: empty }, (_, i) => alone(`e${i}`, 0)),
    ...Array.from({ length: healthy }, (_, i) => alone(`h${i}`, 4)),
  ];

  // Below the threshold: today's behaviour, one page per dead bucket.
  const few = planEmptyBucketAlerts(cov(2, 8));
  assert(few.aggregated === false, "two dead buckets stay per-bucket pages");
  assert(few.pagePools.length === 2, "each of the two is paged on its own key");
  assert(few.settleCodes.length === 0, "nothing is settled silently in per-bucket mode");
  assert(few.clear.length === 8, "the eight healthy buckets may be cleared");

  // At the threshold: one page for the set.
  const many = planEmptyBucketAlerts(cov(AGGREGATE_EMPTY_THRESHOLD, 5));
  assert(many.aggregated === true, "the threshold number of dead buckets aggregates");
  assert(many.pagePools.length === 0, "aggregated mode sends no per-pool page");
  assert(
    many.settleCodes.length === AGGREGATE_EMPTY_THRESHOLD,
    "every dead bucket's own page is settled silently, so switching modes posts no flood",
  );
  assert(many.clear.length === 5, "healthy buckets are still cleared normally");

  // Every bucket dead is systemic at any roster size, even below the threshold.
  const allDead = planEmptyBucketAlerts(cov(3, 0));
  assert(allDead.aggregated === true, "every bucket dead aggregates even under the threshold");

  // A single-bucket org is not a broad outage; one page is already one page.
  const lone = planEmptyBucketAlerts(cov(1, 0));
  assert(lone.aggregated === false, "one bucket, dead, is not an aggregate");
  assert(lone.pagePools.length === 1, "the lone dead bucket still pages");

  // Nothing dead: no pages either way, everything clearable.
  const none = planEmptyBucketAlerts(cov(0, 4));
  assert(none.aggregated === false && none.pagePools.length === 0, "a healthy sweep pages nothing");
  assert(none.clear.length === 4, "a healthy sweep may clear every bucket");

  // The aggregate rides a key that no bucket code can collide with (codes are the
  // 3-digit XBC codes), so it cannot clear or suppress a real bucket's page.
  assert(!/^\d+$/.test(AGGREGATE_BUCKET_CODE), "the aggregate key is not shaped like a bucket code");
}

// --- emptyBucketsAggregateMessage: says how many, and names the cause it MEASURED ---
{
  const systemic = emptyBucketsAggregateMessage(15, 15, 0);
  assert(systemic.includes("15"), "the aggregate page says how many pools are dead");
  assert(/pools/i.test(systemic), "and counts POOLS, which is the unit it now decides on");
  assert(
    /no agent|nobody/i.test(systemic),
    "with zero bookable agents it names that as the shared cause",
  );
  assert(!/^\s*Slate\b/i.test(systemic), "the aggregate page does not open with a Slate label");

  // Agents ARE bookable, so the cause is per-bucket config, not the roster: the
  // page must not blame the roster.
  const partial = emptyBucketsAggregateMessage(6, 15, 40);
  assert(partial.includes("6") && partial.includes("15"), "it says how many of how many");
  assert(/40/.test(partial), "it reports the bookable agent count it measured");
  assert(
    !/no agent is bookable|nobody is bookable/i.test(partial),
    "it does not claim an empty roster when 40 agents are bookable",
  );
  assert(/1 agent is bookable/.test(emptyBucketsAggregateMessage(9, 15, 1)), "singular reads right");
  assert(
    /1 of 15 routing pools has/.test(emptyBucketsAggregateMessage(1, 15, 3)),
    "one dead pool reads as singular",
  );

  // Unreadable count: claim only what was measured (L11). No invented cause.
  const unknown = emptyBucketsAggregateMessage(15, 15, null);
  assert(unknown.includes("15"), "an unreadable agent count still reports the pool count");
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
  const full = emptyBucketsAggregateRecoveredMessage(0, 15);
  assert(/again|cleared/i.test(full), "a full recovery says the condition is over");
  assert(!/still/i.test(full), "a full recovery does not imply leftovers");

  // Dropping below the threshold ends the AGGREGATE, but three buckets are still
  // dead and are about to page on their own: the all-clear must not read as
  // "everything is fine".
  const partial = emptyBucketsAggregateRecoveredMessage(3, 15);
  assert(partial.includes("3"), "a partial recovery says how many are still dead");
  assert(/still/i.test(partial), "a partial recovery says some buckets remain dead");
  assert(!/^\s*Slate\b/i.test(partial), "the all-clear does not open with a Slate label");
}

// --- One page per empty POOL, not one per bucket code (#2237) ---
//
// Sixty codes route through fifteen pools, so a tier with nobody in it is ONE
// finding that used to arrive as six near-identical pages, each naming a code
// and none naming the thing to fix. A three code pool (a backend constrained
// one) arrived as three, which is under the aggregate threshold and so never
// folded.
{
  const pool = (key: string, label: string, codes: string[], eligibleCount: number) =>
    codes.map((code) => ({ code, eligibleCount, poolKey: key, poolLabel: label }));

  const LOW = ["100", "101", "102", "110", "111", "112"];
  const LOW_BEYOND = ["120", "121", "122"];

  {
    const plan = planEmptyBucketAlerts(pool("low", "Low", LOW, 0));
    eq(plan.pagePools.length, 1, "a six code pool with nobody in it pages ONCE");
    eq(plan.pagePools[0]!.codes, LOW, "and the page carries every code in the pool");
    eq(plan.pagePools[0]!.label, "Low", "and the pool's name");
    eq(
      plan.settleCodes.sort(),
      ["101", "102", "110", "111", "112"],
      "the five codes it speaks for are settled silently, not paged and not all-cleared",
    );
  }

  {
    // The alert KEY has to be the same code on every sweep. An unstable one
    // would page under a new key each time and never clear the old, which is
    // the throttle failing open in the noisiest possible way.
    const forward = planEmptyBucketAlerts(pool("low", "Low", LOW, 0));
    const reversed = planEmptyBucketAlerts(pool("low", "Low", [...LOW].reverse(), 0));
    eq(
      forward.pagePools[0]!.representative,
      reversed.pagePools[0]!.representative,
      "the code the page rides on does not depend on the order the rows arrived in",
    );
    eq(forward.pagePools[0]!.representative, "100", "and it is the pool's lowest code");
  }

  {
    const plan = planEmptyBucketAlerts([
      ...pool("low", "Low", LOW, 0),
      ...pool("low-beyond", "Low with Beyond", LOW_BEYOND, 0),
      ...pool("high", "High", ["300", "301"], 4),
    ]);
    eq(plan.pagePools.length, 2, "two empty pools are two pages, not nine");
    eq(plan.settleCodes.length, 7, "and the seven codes they speak for are settled");
    eq(plan.clear.length, 2, "the healthy pool's codes are each still clearable");
    assert(
      plan.clear.every((c) => c.pool.label === "High"),
      "and each clear carries its pool, so the all-clear can name what the page named",
    );
  }

  {
    // The threshold counts POOLS now, which re-aims it: it used to fire on five
    // of sixty codes, which one unstaffed tier reached on its own. Five of
    // fifteen pools is a third of the routing matrix, which is the systemic
    // thing the aggregate was for (L220: merging the unit re-aims every guard
    // calibrated against the whole).
    const pools = (n: number, eligibleCount: number) =>
      Array.from({ length: n }, (_, i) =>
        pool(`p${i}`, `Pool ${i}`, [`${i}00`, `${i}01`], eligibleCount),
      ).flat();

    const under = planEmptyBucketAlerts([
      ...pools(AGGREGATE_EMPTY_THRESHOLD - 1, 0),
      ...pool("ok", "OK", ["900"], 3),
    ]);
    assert(under.aggregated === false, "four empty pools stay four pages");
    eq(under.pagePools.length, AGGREGATE_EMPTY_THRESHOLD - 1, "one each");

    const at = planEmptyBucketAlerts([
      ...pools(AGGREGATE_EMPTY_THRESHOLD, 0),
      ...pool("ok", "OK", ["900"], 3),
    ]);
    assert(at.aggregated === true, "the threshold number of empty POOLS aggregates");
    eq(at.pagePools.length, 0, "and sends no per-pool page");
    eq(
      at.settleCodes.length,
      AGGREGATE_EMPTY_THRESHOLD * 2,
      "every code in every empty pool is settled, since any of them may hold a page",
    );
  }

  {
    const allDead = planEmptyBucketAlerts([
      ...pool("a", "A", ["100", "101"], 0),
      ...pool("b", "B", ["200", "201"], 0),
    ]);
    assert(allDead.aggregated === true, "every pool dead aggregates under the threshold too");

    const lone = planEmptyBucketAlerts(pool("a", "A", ["100", "101"], 0));
    assert(lone.aggregated === false, "one pool, dead, is not an aggregate");
  }

  {
    // A pool nothing can name still pages: the codes are what the reader acts
    // on, and withholding the page because the criteria are unusual would be
    // the worst possible silence.
    const plan = planEmptyBucketAlerts([
      { code: "CUSTOM", eligibleCount: 0, poolKey: "custom", poolLabel: null },
    ]);
    eq(plan.pagePools.length, 1, "an unnamed pool still pages");
    const msg = emptyBucketMessage(plan.pagePools[0]!);
    assert(msg.includes("CUSTOM"), "and its message names the code it could not name a pool for");
  }

  {
    const msg = emptyBucketMessage({
      key: "low", label: "Low", codes: LOW, representative: "100",
    });
    assert(msg.includes("Low"), "the page names the pool");
    assert(
      LOW.every((c) => msg.includes(c)),
      "and lists every bucket code it speaks for, because those are what the landing pages send",
    );
    assert(!/^\s*Slate\b/i.test(msg), "and does not open with a Slate label");
  }
}

// --- emptyPools: the count the aggregate reports ---
{
  const rows = [
    { code: "100", eligibleCount: 0, poolKey: "low", poolLabel: "Low" },
    { code: "101", eligibleCount: 0, poolKey: "low", poolLabel: "Low" },
    { code: "300", eligibleCount: 2, poolKey: "high", poolLabel: "High" },
  ];
  eq(emptyPools(rows).length, 1, "two codes of one empty pool are ONE empty pool");
  eq(emptyPools([]).length, 0, "no coverage means no empty pools");
}

// --- The booker's live notice must not name a key the sweep does not send ---
//
// It used to say "the hourly sweep reports the same buckets as
// empty_buckets:<code>", which was true while every code had its own page. Since
// #2237 a pool pages on its LOWEST code, so for five codes in six that key
// belongs to no alert at all and the reader is sent to search for nothing (L111:
// a message telling somebody how to recover must name something that exists).
{
  const msg = bookerUnstaffedAlert("111");
  assert(msg.includes("111"), "the notice still names the bucket the customer opened");
  assert(
    !/empty_buckets:111/.test(msg),
    "and does not claim a sweep key derived from that code, which the sweep may never send",
  );
  assert(
    /empty_buckets/.test(msg),
    "while still pointing at the family of pages that does cover it",
  );
}

finish();
