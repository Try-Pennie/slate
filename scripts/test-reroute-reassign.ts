// #3249: a reroute move runs through the EXISTING reassign (phase 3 of #3244).
//
// The confirm does not get a second reassign path: it calls `reassignBooking`
// with the corrected bucket and the claimed hold, which the bucket aware swap
// (migration 0166) consumes in the same transaction as the move. These prove the
// reassign carries the reroute into the swap, cleans up the calendar event it
// created when the swap refuses, and writes the history row with the bucket it
// came from and the one it landed in.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reroute-reassign.ts
import { reassignBooking } from "../src/lib/booking/orchestration.ts";
import { RerouteRefusedError, type RerouteSwapArgs } from "../src/lib/booking/reroute.ts";
import type { User } from "../src/lib/db/types.ts";
import { createAsserter, makeDeps, makeBooking, bucket, eventType } from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

const owner = { id: "b", name: "Owner B", email: "b@x.com", bookable: true } as unknown as User;
const reroute: RerouteSwapArgs = {
  holdId: "H1",
  bucketId: "b512",
  requestedBucketId: "b512",
  requestedTier: "ultra_high",
  bookedTier: "ultra_high",
  rungsDropped: 0,
  fromBucketId: bucket.id,
};
const REASON = { code: "bucket_correction", detail: "lead is Ultra High" };

async function run() {
  // --- the swap receives the reroute, and the history row names both buckets ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner });
    await reassignBooking("bk1", "b@x.com", REASON, deps, { initiator: "admin", allowNonBookable: true, reroute });
    const swap = calls.reassignSwaps[0] as { reroute?: RerouteSwapArgs } | undefined;
    assert(swap?.reroute?.holdId === "H1" && swap.reroute.bucketId === "b512", "the swap is called with the hold and the corrected bucket");
    const history = calls.bookingEvents.find((e) => e.action === "reassigned");
    assert(history?.reason_code === "bucket_correction", "the history row carries the reroute's reason");
    assert(history?.from_bucket_id === bucket.id, "with the bucket the booking came from");
    assert(history?.to_bucket_id === "b512", "and the bucket it landed in");
  }

  // --- a plain reassign is untouched: no bucket on the swap, none on the history ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner });
    await reassignBooking("bk1", "b@x.com", { code: "coverage", detail: null }, deps, { initiator: "admin", allowNonBookable: true });
    const swap = calls.reassignSwaps[0] as { reroute?: RerouteSwapArgs } | undefined;
    assert(swap !== undefined && swap.reroute === undefined, "a plain reassign calls the swap with no reroute");
    const history = calls.bookingEvents.find((e) => e.action === "reassigned");
    assert(history?.from_bucket_id === null && history?.to_bucket_id === null, "and records no bucket change");
  }

  // --- the swap refuses: the event it created is cleaned up and the refusal is named ---
  {
    const ctx = { booking: makeBooking({}), bucket, eventType };
    const { deps, calls } = makeDeps({ bookingById: ctx, agentByEmail: owner, reassignSwapRefused: "hold_expired" });
    let thrown: unknown = null;
    try {
      await reassignBooking("bk1", "b@x.com", REASON, deps, { initiator: "admin", allowNonBookable: true, reroute });
    } catch (e) {
      thrown = e;
    }
    assert(thrown instanceof RerouteRefusedError && thrown.code === "hold_expired", "a refused swap surfaces as the swap's own word");
    assert(calls.deleteEvent.length + calls.enqueueEventDeletion.length >= 1, "the calendar event created for the move is cleaned up");
    assert(calls.reassignIntentDeletes.length >= 1, "and its intent dropped");
    assert(!calls.bookingEvents.some((e) => e.action === "reassigned"), "and no history row claims a move");
    assert(ctx.booking.assigned_user_id === "a", "the booking still names its original advisor");
  }
}

await run();
finish();
