// Which buckets route to nobody, and the reactive (booking-time) copy for one
// that a live booking hit. Pure so it runs node-native.
//
// The PROACTIVE per bucket sweep this file used to test was retired by #2505: a
// bucket with nobody in it is not a customer problem while the rest of its debt
// tier can take the lead, and since #2486 the ladder tries every bucket in the
// tier before dropping one. The question is asked per DEBT TIER now, and its
// suite is `scripts/test-tier-staffing.ts`, which covers the paging, the two
// findings, the all-clear and the unmeasured path that used to be covered here.
//
// `emptyBuckets` itself SURVIVES, because the pilot readiness gate still asks it
// whether any real bucket routes to nobody.
// Run: node --experimental-strip-types scripts/test-bucket-coverage.ts
import {
  emptyBuckets,
  noEligibleAgentsAlert,
} from "../src/lib/availability/bucket-coverage.ts";
import { bookerUnstaffedAlert } from "../src/lib/booking/alert-copy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** A bucket in a pool of its own, which is what every case below the pool
 *  section was written against. */
const alone = (code: string, eligibleCount: number, eligibleWithoutLowCount: number | null = eligibleCount) => ({
  code,
  eligibleCount,
  eligibleWithoutLowCount,
  poolKey: `pool-${code}`,
  poolLabel: null,
});

// --- emptyBuckets: a dead zone is a code whose whole LADDER is empty ---
//
// REVERSED by #2483. This used to assert that any code resolving to zero agents
// was a dead zone, which made the Low plus Beyond codes permanently red about a
// state that is correct. It is judged down the tier ladder now, so `511` is
// covered by `411` beneath it, which is where the router really sends that lead.
{
  const cov = [
    alone("411", 3),
    alone("412", 0),
    alone("511", 0),
    alone("611", 1),
  ];
  const empty = emptyBuckets(cov);
  assert(empty.length === 1, "only the code with no staffed rung beneath it is flagged");
  assert(empty.includes("412"), "412 drops to 312, 212, 112, none of which is staffed here");
  assert(!empty.includes("511"), "511 drops to 411, which is staffed, so a lead IS booked");
  assert(!empty.includes("411") && !empty.includes("611"), "covered buckets are NOT flagged");
  assert(emptyBuckets([]).length === 0, "no buckets -> nothing flagged");
  assert(
    emptyBuckets([alone("x", 5)]).length === 0,
    "a fully-covered set flags nothing",
  );
}

// --- noEligibleAgentsAlert: the reactive (booking hit an empty bucket) copy ---
{
  const withCode = noEligibleAgentsAlert("412");
  assert(withCode.includes("412"), "reactive alert names the bucket that failed");
  assert(/no eligible|no bookable|no advisors/i.test(withCode), "reactive alert explains the cause");
  // Defensive: still produces a sensible message if the code is missing.
  assert(noEligibleAgentsAlert(null).length > 0, "reactive alert tolerates a missing bucket code");
}

// --- The booker's live notice must not name a key the sweep does not send ---
//
// It used to say "the hourly sweep reports the same buckets as
// empty_buckets:<code>", which was true while every code had its own page. Since
// #2505 retired the per bucket sweep entirely, so the notice may not name a key
// from it at all: the ongoing question is asked per DEBT TIER now, and a message
// sending somebody to look for an `empty_buckets` page would send them to search
// for something nothing sends (L111: a message telling somebody how to recover
// must name something that exists).
{
  const msg = bookerUnstaffedAlert("111");
  assert(msg.includes("111"), "the notice still names the bucket the customer opened");
  assert(
    !/empty_buckets/.test(msg),
    "and names no key from the retired per bucket sweep, which sends nothing now",
  );
  assert(
    /debt tier/i.test(msg),
    "while still pointing at the thing that does watch it now",
  );
}

// --- A bucket is a dead end only when its whole LADDER is empty (#2483) ---
//
// The Low plus Beyond codes 120, 121 and 122 have no eligible agent by
// construction: no Low agent carries the Beyond backend. Since #1909 a Beyond
// lead overflows sideways to Achieve, so the ladder for 120 is `120, 130` and the
// whole Low Achieve pool serves it. Judged per code, those three were
// permanently "nobody to route to", so both the hourly page and the flip morning
// readiness gate were red about three buckets that are correct, on the healthy
// day (L36).
//
// It asks `tierLadder` rather than re-deriving a rule here, so it can never claim
// a rescue the router does not perform, and a widened ladder moves both together.
{
  const rung = (code: string, eligibleCount: number, eligibleWithoutLowCount: number | null = eligibleCount) => ({
    code,
    eligibleCount,
    eligibleWithoutLowCount,
    poolKey: `pool-${code}`,
    poolLabel: null,
  });

  // The Beyond hole: empty codes, and the Achieve rung beside them is staffed.
  // The legal digit rides unchanged onto every rung, so 121 is rescued by 131
  // and 122 by 132, never by 130. In production all sixty codes exist.
  const lowBeyondHole = [
    rung("100", 84),
    rung("120", 0),
    rung("121", 0),
    rung("122", 0),
    rung("130", 84),
    rung("131", 84),
    rung("132", 84),
  ];
  eq(
    emptyBuckets(lowBeyondHole).length,
    0,
    "an empty Beyond code is not a dead end while its Achieve overflow rung is staffed",
  );

  // THE FAIL OPEN THIS MUST NOT HAVE (#2253). 111 and 112 share a tier, a backend
  // and a pool, and the ladder does NOT walk sideways between them: a lead on 111
  // is not booked by the person named on 112 by hand. Judging by the debt tier
  // instead of the ladder would silence exactly the page that issue restored.
  const handStaffedSibling = [rung("111", 0), rung("112", 1)];
  const siblings = emptyBuckets(handStaffedSibling);
  eq(siblings.length, 1, "a staffed SIBLING in the same tier is no rescue");
  assert(siblings.includes("111"), "and the unroutable code is still named");

  // A whole ladder dark is still a dead end, on every code in it.
  const dark = emptyBuckets([rung("500", 0), rung("400", 0), rung("300", 0), rung("200", 0), rung("100", 0)]);
  eq(dark.length, 5, "every code of a dark ladder is flagged");

  // A code that is not an XBC has no ladder to be rescued by, so it answers for
  // itself. Hand created buckets (#2006) live outside the matrix.
  eq(emptyBuckets([rung("house", 0), rung("100", 84)]).length, 1, "a non XBC code is judged alone");

  // A rung nobody measured is not a staffed rung.
  eq(emptyBuckets([rung("522", 0)]).length, 1, "a ladder whose rungs are absent from the sweep is a dead end");

  // #2842: below a top tier lead's own tier only advisors WITHOUT Low count, as
  // the router counts them. A Medium pool made entirely of Low carriers is no
  // rescue for an Ultra lead, and is one for a High lead.
  const lowOnlyBelow = [rung("511", 0), rung("411", 5, 0), rung("311", 9, 0), rung("211", 30, 0), rung("111", 80, 80)];
  assert(emptyBuckets(lowOnlyBelow).includes("511"), "an Ultra code only Low carriers could serve is a dead end");
  assert(!emptyBuckets(lowOnlyBelow).includes("411"), "a Very High code with advisors of its own is not empty");
  assert(
    emptyBuckets([rung("411", 0), rung("311", 9, 0), rung("211", 30, 0), rung("111", 80, 80)]).includes("411"),
    "an empty Very High code only Low carriers could serve is a dead end",
  );
  assert(!emptyBuckets([rung("311", 0), rung("211", 30, 0)]).includes("311"), "a High code keeps Low carriers");
  assert(!emptyBuckets([rung("511", 0), rung("211", 30, 2)]).includes("511"), "one advisor without Low is a rescue");
  // Unmeasured is no rescue, never a staffed rung.
  assert(emptyBuckets([rung("511", 0), rung("411", 5, null)]).includes("511"), "an unmeasured count is no rescue");
}

finish();
