// #3485 Part 1: a coverage move that lands on a LOWER rung of the tier ladder moves the
// call into that rung's bucket, through Reroute's own swap: hold the advisor, claim the
// hold, then the bucket aware reassign, which consumes the hold and records the rung on
// the booking the same way a reroute does. Any failure after the hold lets it go, so a
// failed move never leaves the advisor blocked for leads until the hold runs out.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-coverage-cascade.ts
import { moveCoverageAcrossBuckets, type CascadeMoveDeps } from "../src/lib/booking/coverage-cascade.ts";
import type { RerouteSwapArgs } from "../src/lib/booking/reroute.ts";
import type { Bucket } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const from = { id: "b212", code: "212", org_id: "org1" } as unknown as Bucket;
const to = { id: "b112", code: "112", org_id: "org1" } as unknown as Bucket;
const move = {
  booking: { id: "bk1", org_id: "org1" },
  agentUserId: "LOW1",
  agentEmail: "low1@x.com",
  from,
  to,
  rungsDropped: 1,
  createdBy: "mgr1",
};

interface FakeOpts {
  placeRefused?: string;
  claimRefused?: string;
  reassignThrows?: Error;
  releaseThrows?: Error;
}

function fake(o: FakeOpts = {}) {
  const steps: string[] = [];
  let placed: unknown = null;
  let swap: RerouteSwapArgs | null = null;
  const releaseFailures: unknown[] = [];
  const deps: CascadeMoveDeps = {
    placeHold: async (args) => {
      steps.push("place");
      placed = args;
      return o.placeRefused
        ? { placed: false, refused: o.placeRefused as never }
        : { placed: true, holdId: "h1", expiresAt: "2031-01-01T00:05:00.000Z" };
    },
    claimHold: async (orgId, bookingId, holdId) => {
      steps.push(`claim ${orgId} ${bookingId} ${holdId}`);
      return { refused: (o.claimRefused ?? null) as never, result: null, agentUserId: "LOW1", targetBucketId: "b112" };
    },
    reassign: async (bookingId, email, args) => {
      steps.push(`reassign ${bookingId} ${email}`);
      swap = args;
      if (o.reassignThrows) throw o.reassignThrows;
    },
    releaseHold: async (bookingId) => {
      steps.push(`release ${bookingId}`);
      if (o.releaseThrows) throw o.releaseThrows;
    },
    onReleaseFailed: (_bookingId, err) => {
      releaseFailures.push(err);
    },
  };
  return { deps, steps, placed: () => placed, swap: () => swap, releaseFailures };
}

async function rejects(p: Promise<unknown>): Promise<Error | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return err as Error;
  }
}

async function run() {
  // The whole move, in order: hold, claim, swap.
  {
    const f = fake();
    await moveCoverageAcrossBuckets(f.deps, move);
    eq(f.steps, ["place", "claim org1 bk1 h1", "reassign bk1 low1@x.com"], "the move holds, claims, then swaps, and releases nothing");
    eq(f.placed(), {
      orgId: "org1", bookingId: "bk1", agentUserId: "LOW1", requestedBucketId: "b212", targetBucketId: "b112",
      rungsDropped: 1, createdBy: "mgr1",
    }, "the hold records the booking's own bucket as the one asked for, the rung's as the target, and the drop");
    eq(f.swap(), {
      holdId: "h1", bucketId: "b112", requestedBucketId: "b212", requestedTier: "medium", bookedTier: "low",
      rungsDropped: 1, fromBucketId: "b212",
    }, "the swap carries the hold, both buckets, both tiers and the drop, as a reroute's does");
  }

  // A refused hold: nothing was held, so nothing is claimed, swapped or released.
  {
    const f = fake({ placeRefused: "agent_busy" });
    const err = await rejects(moveCoverageAcrossBuckets(f.deps, move));
    assert(err !== null, "a refused hold fails the move, so the engine retries it");
    assert(/agent_busy/.test(err?.message ?? ""), `and says why (got ${err?.message})`);
    eq(f.steps, ["place"], "with no claim, no swap and no release");
  }

  // A refused claim: the hold exists, so it is let go.
  {
    const f = fake({ claimRefused: "booking_moved" });
    const err = await rejects(moveCoverageAcrossBuckets(f.deps, move));
    assert(/booking_moved/.test(err?.message ?? ""), `a refused claim fails the move and says why (got ${err?.message})`);
    eq(f.steps, ["place", "claim org1 bk1 h1", "release bk1"], "and releases the hold, never swapping");
  }

  // A swap that throws: the hold is released and the swap's own error is the one surfaced.
  {
    const boom = new Error("calendar event create failed: 503");
    const f = fake({ reassignThrows: boom });
    const err = await rejects(moveCoverageAcrossBuckets(f.deps, move));
    assert(err === boom, "the swap's own error is the one thrown");
    eq(f.steps.at(-1), "release bk1", "after the hold is released");
  }

  // The release failing too is reported, and never hides the error that caused it.
  {
    const boom = new Error("calendar event create failed: 503");
    const releaseErr = new Error("delete reroute hold failed: connection reset");
    const f = fake({ reassignThrows: boom, releaseThrows: releaseErr });
    const err = await rejects(moveCoverageAcrossBuckets(f.deps, move));
    assert(err === boom, "a failed release does not replace the swap's error");
    assert(f.releaseFailures.length === 1 && f.releaseFailures[0] === releaseErr, "and is itself reported, since the advisor then stays held until the lease ends");
  }
}

await run();
finish();
