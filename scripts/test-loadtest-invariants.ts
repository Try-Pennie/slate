// Regression lock for the #440 load/soak invariant check. The live soak surfaced
// that run.ts's stuck-slot check fetched `busy_blocks?source=eq.slate` and filtered
// client-side, but that PostgREST list caps at 1000 rows: with a large seed it
// sampled a clean subset and FALSE-PASSED while 333 cancelled bookings still held a
// slate busy_block. It also drove selfheal a fixed number of ticks, so it checked
// the stuck-slot invariant before the batch-limited (#428) reconcile had converged.
//
// These tests pin the fixed contract: counts come from uncapped server-side count()
// queries, and selfheal is driven to convergence BEFORE the invariants are read.
// Driven through in-memory fakes, no DB. Run:
//   node --experimental-strip-types scripts/test-loadtest-invariants.ts
import {
  driveSelfhealToConvergence,
  checkSoakInvariants,
  computeFreshness,
  type InvariantDeps,
} from "./loadtest/invariants.ts";
import { assert, finish } from "./lib/harness.ts";

// A count() fake that dispatches on distinctive substrings of the PostgREST filter.
function countFake(byFilter: (filter: string) => number) {
  return async (filter: string) => byFilter(filter);
}
const noDeliveries: InvariantDeps["listAll"] = async () => [];
const oneSelfhealNoop = async () => ({ freed: 0, recreated: 0 });

async function main() {
  // 1. Convergence loop stops as soon as a tick frees nothing.
  {
    const script = [
      { freed: 200, recreated: 0 },
      { freed: 53, recreated: 0 },
      { freed: 0, recreated: 0 },
    ];
    let i = 0;
    const r = await driveSelfhealToConvergence(async () => script[i++], 40);
    assert(r.converged, "convergence: reports converged when a tick frees nothing");
    assert(r.ticks === 3, `convergence: stops on the first empty tick (got ${r.ticks})`);
    assert(r.freedTotal === 253, `convergence: sums freed across ticks (got ${r.freedTotal})`);
  }

  // 2. Convergence loop never spins forever: bails at maxTicks, reports not-converged.
  {
    let calls = 0;
    const r = await driveSelfhealToConvergence(
      async () => {
        calls++;
        return { freed: 200, recreated: 0 };
      },
      5,
    );
    assert(!r.converged, "convergence: reports NOT converged when it never drains");
    assert(r.ticks === 5 && calls === 5, `convergence: honors maxTicks (got ${r.ticks})`);
  }

  // 3. THE REGRESSION: a nonzero uncapped stuck-slate count must FAIL, even though a
  //    capped client-side list would have looked clean. The fake returns the true
  //    count (333) for the cancelled-slate filter; the checker must surface it.
  {
    const deps: InvariantDeps = {
      count: countFake((f) =>
        f.includes("bookings.status=eq.cancelled") ? 333 : 0,
      ),
      listAll: noDeliveries,
      driveSelfheal: oneSelfhealNoop,
    };
    const r = await checkSoakInvariants(deps);
    assert(!r.pass, "cap bug: FAILS when cancelled bookings still hold a slate block");
    assert(
      r.failures.some((m) => m.includes("333") && /slate/i.test(m)),
      `cap bug: names the stuck count (got ${JSON.stringify(r.failures)})`,
    );
  }

  // 4. All-clean state passes and reports the selfheal tick count.
  {
    const deps: InvariantDeps = {
      count: countFake(() => 0),
      listAll: async () => [
        { endpoint_id: "e1", event: "booking.cancelled", dedupe_key: "a" },
        { endpoint_id: "e1", event: "booking.cancelled", dedupe_key: "b" },
      ],
      driveSelfheal: oneSelfhealNoop,
    };
    const r = await checkSoakInvariants(deps);
    assert(r.pass, "clean: passes when every uncapped count is 0 and deliveries are unique");
  }

  // 5. Duplicate (endpoint,event,dedupe_key) must FAIL exactly-once.
  {
    const deps: InvariantDeps = {
      count: countFake(() => 0),
      listAll: async () => [
        { endpoint_id: "e1", event: "booking.cancelled", dedupe_key: "dup" },
        { endpoint_id: "e1", event: "booking.cancelled", dedupe_key: "dup" },
      ],
      driveSelfheal: oneSelfhealNoop,
    };
    const r = await checkSoakInvariants(deps);
    assert(!r.pass, "exactly-once: FAILS on a duplicate dedupe key");
    assert(
      r.failures.some((m) => /duplicate/i.test(m)),
      "exactly-once: names the duplicate failure",
    );
  }

  // 6. ORDERING: the stuck-slate count is read only AFTER selfheal converges. The fake
  //    keeps a live backlog that only reconcile drains; if the check ran before
  //    convergence it would see a nonzero count and fail.
  {
    let stuckRemaining = 500;
    const deps: InvariantDeps = {
      count: countFake((f) =>
        f.includes("bookings.status=eq.cancelled") ? stuckRemaining : 0,
      ),
      listAll: noDeliveries,
      driveSelfheal: async () => {
        const freed = Math.min(200, stuckRemaining);
        stuckRemaining -= freed;
        return { freed, recreated: 0 };
      },
    };
    const r = await checkSoakInvariants(deps);
    assert(r.pass, "ordering: passes because the count is read post-convergence");
    assert(r.selfhealTicks >= 3, `ordering: drove selfheal to convergence (got ${r.selfhealTicks})`);
  }

  // 7. FRESHNESS cap-safety (#725): computeFreshness aggregates the FULL result set.
  //    Feed 1500 rows through the paginating listAll fake; total must be 1500, not
  //    truncated at PostgREST's 1000-row cap the way run.ts freshness() used to be.
  {
    const now = Date.parse("2026-07-09T12:00:00.000Z");
    const rows1500 = Array.from({ length: 1500 }, () => ({
      computed_at: new Date(now).toISOString(),
    }));
    const f = await computeFreshness(async () => rows1500, now);
    assert(f.total === 1500, `freshness: counts every row, not a 1000 cap (got ${f.total})`);
    assert(f.stale6m === 0, "freshness: none stale when all just computed");
  }

  // 8. FRESHNESS math: stale count (>6m) and spread over a mixed set at a fixed now.
  {
    const now = Date.parse("2026-07-09T12:00:00.000Z");
    const rowsMixed = [
      { computed_at: new Date(now - 10 * 60_000).toISOString() }, // 10m old -> stale
      { computed_at: new Date(now - 7 * 60_000).toISOString() }, //  7m old -> stale
      { computed_at: new Date(now - 60_000).toISOString() }, //     1m old -> fresh
      { computed_at: new Date(now).toISOString() }, //             now      -> fresh
    ];
    const f = await computeFreshness(async () => rowsMixed, now);
    assert(f.total === 4, `freshness: total over mixed set (got ${f.total})`);
    assert(f.stale6m === 2, `freshness: counts rows older than 6m (got ${f.stale6m})`);
    assert(f.spreadSec === 600, `freshness: spread is newest-oldest seconds (got ${f.spreadSec})`);
  }

  // 9. FRESHNESS empty set: no rows yields zero spread, not a crash on ts[-1].
  {
    const f = await computeFreshness(async () => [], Date.parse("2026-07-09T12:00:00.000Z"));
    assert(f.total === 0 && f.spreadSec === 0, "freshness: empty set yields zero total and spread");
  }

  finish();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
