// #3248: placing, releasing and expiring a reroute hold refresh the held advisor's
// buckets, so the slot cache stops (and starts again) offering the times only they
// could serve.
//
// The busy block itself is written and removed by triggers (migration 0167), proved
// in a real database by `pnpm verify:reroute-holds-sql`. What is left in TypeScript
// is the recompute after each change and the refusal handling, driven here through
// injected fakes.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reroute-hold-store.ts
import {
  placeRerouteHold,
  releaseRerouteHold,
  sweepExpiredRerouteHoldBlocks,
  type RerouteHoldStoreDeps,
} from "../src/lib/booking/reroute-hold-store.ts";
import { assert, eq, finish } from "./lib/harness.ts";

function fake(over: Partial<RerouteHoldStoreDeps> = {}) {
  const refreshed: string[][] = [];
  const deps: RerouteHoldStoreDeps = {
    placeRpc: async () => ({ data: [{ hold_id: "H1", expires_at: "2031-03-04T10:05:00Z", refused: null }], error: null }),
    deleteUnconsumed: async () => ({ data: [{ agent_user_id: "B" }], error: null }),
    pruneRpc: async () => ({ data: [{ user_id: "B" }, { user_id: "C" }, { user_id: "B" }], error: null }),
    refreshPools: async (ids) => {
      refreshed.push(ids);
    },
    ...over,
  };
  return { deps, refreshed };
}

const args = {
  orgId: "org1", bookingId: "K1", agentUserId: "B", requestedBucketId: "b2", targetBucketId: "b2", rungsDropped: 0, createdBy: "admin",
};

async function run() {
  // --- place ------------------------------------------------------------------------
  {
    const { deps, refreshed } = fake();
    const r = await placeRerouteHold(args, deps);
    eq(r, { placed: true, holdId: "H1", expiresAt: "2031-03-04T10:05:00Z" }, "a placed hold returns its id and expiry");
    eq(refreshed, [["B"]], "and refreshes the held advisor's buckets, so their held time leaves the offer");
  }
  {
    const { deps, refreshed } = fake({ placeRpc: async () => ({ data: [{ hold_id: null, expires_at: null, refused: "agent_busy" }], error: null }) });
    eq(await placeRerouteHold(args, deps), { placed: false, refused: "agent_busy" }, "a refusal is returned as its own word");
    eq(refreshed, [], "and refreshes nothing, since nothing changed");
  }
  {
    const { deps } = fake({ placeRpc: async () => ({ data: null, error: { message: "connection reset" } }) });
    let err = "";
    try { await placeRerouteHold(args, deps); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    assert(/connection reset/.test(err), `a failed placement throws rather than reading as refused or placed (got ${err})`);
  }
  {
    const { deps } = fake({ placeRpc: async () => ({ data: [], error: null }) });
    let err = "";
    try { await placeRerouteHold(args, deps); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    assert(/no row/.test(err), `an empty answer throws: the function always returns one row (got ${err})`);
  }

  // --- release ----------------------------------------------------------------------
  {
    const { deps, refreshed } = fake();
    eq(await releaseRerouteHold("K1", deps), { released: true }, "releasing a live hold says it did");
    eq(refreshed, [["B"]], "and refreshes the advisor it freed");
  }
  {
    const { deps, refreshed } = fake({ deleteUnconsumed: async () => ({ data: [], error: null }) });
    eq(await releaseRerouteHold("K1", deps), { released: false }, "releasing when nothing is held says so");
    eq(refreshed, [], "and refreshes nothing");
  }
  {
    const { deps } = fake({ deleteUnconsumed: async () => ({ data: null, error: { message: "permission denied" } }) });
    let err = "";
    try { await releaseRerouteHold("K1", deps); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    assert(/permission denied/.test(err), `a failed release throws (got ${err})`);
  }

  // --- the expiry sweep ---------------------------------------------------------------
  {
    const { deps, refreshed } = fake();
    eq(await sweepExpiredRerouteHoldBlocks(deps), { freed: 3 }, "the sweep counts every block it removed");
    eq(refreshed, [["B", "C"]], "and refreshes each freed advisor once");
  }
  {
    const { deps, refreshed } = fake({ pruneRpc: async () => ({ data: [], error: null }) });
    eq(await sweepExpiredRerouteHoldBlocks(deps), { freed: 0 }, "a quiet sweep frees nothing");
    eq(refreshed, [], "and refreshes nothing");
  }
  {
    const { deps } = fake({ pruneRpc: async () => ({ data: null, error: { message: "timeout" } }) });
    let err = "";
    try { await sweepExpiredRerouteHoldBlocks(deps); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    assert(/timeout/.test(err), `a failed sweep throws, so the lane does not stamp it as run (got ${err})`);
  }
}

run().then(finish);
