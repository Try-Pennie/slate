// What a confirm's commit chain costs, and whether its budget covers it (#3338).
//
// A confirm promoted late in a crowd used to start its reservation, calendar event
// and insert with a few seconds left, be cut off at the insert, and tell the lead to
// retry while the reservation drain later booked them anyway (L12). The confirm
// path now asks this module, before it writes anything. What is pinned here:
//  - the cost is the slowest of the recent chains this isolate measured, never one
//    sample, and a log with no fresh chain says so (null), never zero;
//  - a sample stops counting once it is older than `COMMIT_COST_MAX_AGE_MS`, whether
//    or not anything newer was recorded, so a refused confirm (which records
//    nothing) can never keep a slow sample alive (L465);
//  - the expected cost is never below the confirm's own slowest Google call;
//  - a budget that does not cover the cost, or is already spent, starts nothing,
//    and a confirm outside any budget (a suite, a drain) is never refused.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-commit-cost.ts
import {
  COMMIT_COST_MAX_AGE_MS,
  COMMIT_COST_SAMPLES,
  budgetCovers,
  expectedCommitMs,
  makeCommitCostLog,
} from "../src/lib/booking/commit-cost.ts";
import { CONFIRM_CLAIM_LEASE_MS } from "../src/lib/booking/confirm-queue.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const T = 1_000_000;

// --- the log --------------------------------------------------------------------
{
  const log = makeCommitCostLog();
  eq(log.slowestRecentMs(T), null, "a log with no chain yet has no cost, never zero");
  log.record(4_000, T);
  log.record(6_500, T);
  log.record(5_000, T);
  eq(log.slowestRecentMs(T), 6_500, "the slowest recent chain, not the last one");
  log.record(Number.NaN, T);
  log.record(-5, T);
  eq(log.slowestRecentMs(T), 6_500, "a reading that is not a duration is ignored");
}
{
  const log = makeCommitCostLog({ samples: 3 });
  log.record(9_000, T);
  for (let i = 0; i < 3; i++) log.record(2_000, T);
  eq(log.slowestRecentMs(T), 2_000, "a window of 3 forgets the chain 4 back");
  assert(COMMIT_COST_SAMPLES > 1, "the production window holds several chains (L656)");
}

// --- samples age by TIME, not by what comes after them (L465) ---------------------
{
  const log = makeCommitCostLog();
  log.record(11_000, T);
  eq(log.slowestRecentMs(T + COMMIT_COST_MAX_AGE_MS), 11_000, "a sample counts up to its age bound, inclusive");
  eq(
    log.slowestRecentMs(T + COMMIT_COST_MAX_AGE_MS + 1),
    null,
    "past it the sample stops counting with nothing newer recorded, so refusals cannot keep it alive",
  );
  log.record(2_000, T + 5_000);
  eq(log.slowestRecentMs(T + COMMIT_COST_MAX_AGE_MS + 1), 2_000, "a newer sample still counts once the older one has aged out");
}
eq(
  COMMIT_COST_MAX_AGE_MS,
  CONFIRM_CLAIM_LEASE_MS,
  "the age bound is the longest a confirm can be working, the line's lease (pinned to the budget plus cleanup by test-confirm-queue)",
);

// --- the expected cost ------------------------------------------------------------
eq(expectedCommitMs({ slowestRecentChainMs: 5_000, slowestGoogleCallMs: 3_000 }), 5_000, "a measured chain sets the cost");
eq(expectedCommitMs({ slowestRecentChainMs: 2_000, slowestGoogleCallMs: 3_000 }), 3_000, "never below the confirm's own slowest Google call");
eq(expectedCommitMs({ slowestRecentChainMs: null, slowestGoogleCallMs: 3_000 }), 3_000, "an isolate with no fresh chain is judged on the request's own call");
eq(expectedCommitMs({ slowestRecentChainMs: null, slowestGoogleCallMs: 0 }), 0, "nothing measured is zero, which only a spent budget refuses");

// --- whether the budget covers it ---------------------------------------------------
eq(budgetCovers(null, 60_000), true, "outside any budget nothing can cut it off, so it may start");
eq(budgetCovers(6_000, 5_000), true, "a budget that covers the cost may start");
eq(budgetCovers(5_000, 5_000), true, "exactly the cost may start");
eq(budgetCovers(4_999, 5_000), false, "a budget short of the cost starts nothing");
eq(budgetCovers(0, 0), false, "a spent budget starts nothing, however cheap the work");
eq(budgetCovers(-1_500, 0), false, "and nor does an overrun one");

finish();
