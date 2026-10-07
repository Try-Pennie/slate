// A confirm never STARTS its commit chain without the budget to finish it (#3338).
//
// The chain is the reservation, the advisor's calendar event and the booking insert.
// Cut off part way, it leaves a reservation and an event that the drain later turns
// into a booking for a lead who was told to try again (L12). So the confirm asks,
// before it writes anything, whether what its budget has left covers what the chain
// costs, measured (`commit-cost.ts`): this isolate's recent chains, and never less
// than the confirm's own slowest Google call. Short of it, the lead is told to retry
// with nothing started. Driven against the real orchestration with the shared fake,
// under the real call budget, on a clock the fakes move.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-commit-gate.ts
import { createBooking, DependencyTimeoutError, timeoutAsRetryable, type BookingDeps } from "../src/lib/booking/orchestration.ts";
import { dependencyTimeoutAlert } from "../src/lib/booking/alert-copy.ts";
import { budgetLeftMs, withinCallBudget } from "../src/lib/call-budget.ts";
import { COMMIT_COST_MAX_AGE_MS, makeCommitCostLog } from "../src/lib/booking/commit-cost.ts";
import { createAsserter, makeDeps, input } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();


const realNow = Date.now;
let clock = Date.parse("2026-06-01T12:00:00.000Z");
Date.now = () => clock;

/** The writes the commit chain makes; none may happen on a refusal. */
const WRITES = ["reservations", "createEvent", "insertBooking"] as const;

async function confirm(deps: BookingDeps): Promise<{ ok: boolean; err: unknown }> {
  try {
    await withinCallBudget(12_000, "the booking confirm", () => createBooking(input, deps), () => Date.now());
    return { ok: true, err: null };
  } catch (err) {
    return { ok: false, err };
  }
}

/** Deps whose live check takes `checkMs` and whose calendar write takes `writeMs`. */
function timed(checkMs: number, writeMs: number) {
  const made = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
  const check = made.deps.verifyFree;
  made.deps.verifyFree = async (...args) => {
    clock += checkMs;
    return check(...args);
  };
  const write = made.deps.createEvent;
  made.deps.createEvent = async (...args) => {
    clock += writeMs;
    return write(...args);
  };
  return made;
}

async function main() {
  // --- an isolate that measured slow chains: covered, it books, and records ---------
  {
    const { deps, calls } = timed(1_000, 2_000);
    deps.commitCosts.record(6_000, clock);
    const r = await confirm(deps);
    assert(r.ok, `covered: 11s left against a 6s chain books (got ${String(r.err)})`);
    assert(calls.insertBooking.length === 1, "covered: the booking was written");
    assert(
      deps.commitCosts.slowestRecentMs(clock) === 6_000,
      `covered: its own 2s chain is recorded beside the slower one (got ${deps.commitCosts.slowestRecentMs(clock)})`,
    );
  }
  {
    const { deps } = timed(0, 2_000);
    const r = await confirm(deps);
    assert(r.ok, "a first chain on a fresh isolate books");
    assert(deps.commitCosts.slowestRecentMs(clock) === 2_000, `the chain is measured from the reservation to the insert's answer (got ${deps.commitCosts.slowestRecentMs(clock)})`);
  }

  // --- not covered by this isolate's measured chains: retry, nothing started --------
  {
    const { deps, calls } = timed(8_000, 2_000);
    deps.commitCosts.record(6_000, clock);
    const r = await confirm(deps);
    const err = r.err as DependencyTimeoutError;
    assert(
      !r.ok && err instanceof DependencyTimeoutError && timeoutAsRetryable(err) === err,
      `short of the chain: told to retry, the retryable timeout (got ${String(r.err)})`,
    );
    assert(err.neededMs === 8_000, `the cost is the larger of the isolate's 6s chains and its own 8s check (got ${err.neededMs})`);
    assert(err.timeoutMs === 4_000, `with the 4s actually left (got ${err.timeoutMs})`);
    for (const w of WRITES) assert(calls[w].length === 0, `short of the chain: no ${w} was started`);
    const page = dependencyTimeoutAlert(err);
    assert(/needs about 8 seconds and the request had 4 seconds left, so Slate did not start it/.test(page), `the page says what was measured (got ${page})`);
    assert(!/did not answer/.test(page), "and never that something failed to answer, since nothing was asked");
  }

  // --- a cold isolate is judged on the confirm's own slowest Google call ------------
  {
    const { deps, calls } = timed(9_000, 100);
    const r = await confirm(deps);
    assert(!r.ok && r.err instanceof DependencyTimeoutError, `cold, after a 9s check with 3s left: told to retry (got ${String(r.err)})`);
    for (const w of WRITES) assert(calls[w].length === 0, `cold: no ${w} was started`);
    // Control (L159): the same cold isolate with time to spare books.
    const fast = timed(2_000, 100);
    assert((await confirm(fast.deps)).ok, "cold, after a 2s check with 10s left: books");
  }

  // --- a budget already spent: retry, nothing started, and said as that -------------
  {
    const { deps, calls } = timed(0, 0);
    let err: unknown = null;
    try {
      // Opened 13 seconds ago, so spent before the confirm starts.
      await withinCallBudget(12_000, "the booking confirm", () => createBooking(input, deps), () => Date.now() - 13_000);
    } catch (e) {
      err = e;
    }
    const t = err as DependencyTimeoutError;
    assert(t instanceof DependencyTimeoutError && t.timeoutMs === 0, `spent: the time left is clamped at zero, never negative (got ${String(err)}, ${t?.timeoutMs})`);
    for (const w of WRITES) assert(calls[w].length === 0, `spent: no ${w} was started`);
    const page = dependencyTimeoutAlert(t);
    assert(/had no time left for writing the booking and its calendar event, so Slate did not start it/.test(page), `spent: the page says there was no time left (got ${page})`);
    assert(!/-\s?\d|\b0ms\b|0 seconds/.test(page), `spent: and never a negative or a zero (got ${page})`);
  }

  // --- one long chain never locks the isolate out (L465) --------------------------
  //
  // The gate refuses a confirm whose budget is short of the measured cost, and a
  // refused confirm records nothing. So a sample that can only be replaced by a
  // newer one would hold every later confirm out for good once it exceeded what
  // they have left. Two ways in, each tested on one isolate's record over time:
  //  - a chain the budget cut off at the insert is not what a chain costs and is
  //    never recorded;
  //  - a chain that did finish, slowly, stops counting once it is older than
  //    `COMMIT_COST_MAX_AGE_MS`, whether or not anything newer was recorded.
  {
    const isolate = makeCommitCostLog();
    const onIsolate = (checkMs: number, writeMs: number) => {
      const made = timed(checkMs, writeMs);
      made.deps.commitCosts = isolate;
      // The insert keeps the budget as the real client does: refused once it is spent.
      const insert = made.deps.insertBooking;
      made.deps.insertBooking = async (row) =>
        budgetLeftMs() === 0 ? { ok: false, conflict: false, error: { message: "DeadlineExceededError: supabase did not answer within 0ms, when the booking confirm ran out of its 12000ms" } } : insert(row);
      return made;
    };
    const cut = await confirm(onIsolate(0, 13_000).deps);
    assert(!cut.ok, `lockout: a 13s calendar write leaves the insert to a spent budget (got ${String(cut.err)})`);
    assert(isolate.slowestRecentMs(clock) === null, "lockout: a chain cut off at the insert is not recorded as what a chain costs");
    const after: string[] = [];
    for (let i = 0; i < 4; i++) {
      clock += 60_000;
      const r = await confirm(onIsolate(2_000, 2_000).deps);
      after.push(r.ok ? "booked" : "refused");
    }
    assert(
      after.every((o) => o === "booked"),
      `lockout: ordinary confirms after a cut off chain are booked, never refused for good (got ${after.join(",")})`,
    );
  }
  {
    const isolate = makeCommitCostLog();
    const onIsolate = (checkMs: number, writeMs: number) => {
      const made = timed(checkMs, writeMs);
      made.deps.commitCosts = isolate;
      return made;
    };
    const slow = await confirm(onIsolate(0, 9_000).deps);
    assert(slow.ok && isolate.slowestRecentMs(clock) === 9_000, `aging: a 9s chain that finished inside its budget is recorded (got ${isolate.slowestRecentMs(clock)})`);
    clock += 5_000;
    const soon = await confirm(onIsolate(4_000, 1_000).deps);
    assert(!soon.ok, "aging: 5s later, a confirm with 8s left is still held to the fresh 9s chain");
    clock += COMMIT_COST_MAX_AGE_MS;
    const later = await confirm(onIsolate(4_000, 1_000).deps);
    assert(later.ok, `aging: once the 9s chain is older than ${COMMIT_COST_MAX_AGE_MS}ms it stops counting, with nothing newer recorded (got ${String(later.err)})`);
  }

  // --- only a chain that committed inside its budget is recorded --------------------
  {
    // Committed, but answered after the budget was spent: what a budget allowed,
    // not what a chain costs.
    const late = timed(0, 13_000);
    const r = await confirm(late.deps);
    assert(r.ok, "late commit: an insert that still answered ok gives the lead their booking");
    assert(late.deps.commitCosts.slowestRecentMs(clock) === null, "late commit: answered after the budget was spent, so not recorded");
    // Lost to a race: the chain did not commit.
    const raced = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]), insertBookingConflict: true });
    await confirm(raced.deps);
    assert(raced.deps.commitCosts.slowestRecentMs(clock) === null, "lost race: a chain that did not commit is not recorded");
  }

  // --- a chain cut off before the insert answered measured nothing -----------------
  {
    const { deps } = timed(0, 0);
    deps.createEvent = async () => {
      clock += 3_000;
      throw new Error("calendar write failed");
    };
    await confirm(deps);
    assert(deps.commitCosts.slowestRecentMs(clock) === null, "a chain that never reached the insert records nothing");
  }

  Date.now = realNow;
  finish();
}

main().catch((err) => {
  Date.now = realNow;
  console.error(err);
  process.exit(1);
});
