import type { RerouteSwapArgs } from "./reroute.ts";
import type { ClaimedRerouteHold } from "./reroute-wiring.ts";
import type { PlaceRerouteHoldArgs, PlaceRerouteHoldResult } from "./reroute-hold-store.ts";
import type { Bucket } from "../db/types.ts";
import { tierKeyOf } from "../routing/tiers.ts";

/** The side effects a cross bucket coverage move needs; `service.ts` wires Reroute's own. */
export interface CascadeMoveDeps {
  /** `placeRerouteHold`: hold the advisor for this call, refused when they are busy or held. */
  placeHold(args: PlaceRerouteHoldArgs): Promise<PlaceRerouteHoldResult>;
  /** `claim_reroute_hold`: turn the hold into a confirm lease, refused when it has moved on. */
  claimHold(orgId: string, bookingId: string, holdId: string): Promise<ClaimedRerouteHold>;
  /** The reassign with Reroute's swap args, which consumes the hold. Throws on failure. */
  reassign(bookingId: string, agentEmail: string, swap: RerouteSwapArgs): Promise<void>;
  /** Let the booking's unconsumed hold go. */
  releaseHold(bookingId: string): Promise<unknown>;
  /** A release that itself failed after a failed move. Never throws. */
  onReleaseFailed(bookingId: string, err: unknown): void;
}

/** One coverage move into a lower rung's bucket. */
export interface CascadeMove {
  booking: { id: string; org_id: string };
  agentUserId: string;
  agentEmail: string;
  /** The bucket the call is in, which is the one the sweep searched for. */
  from: Bucket;
  /** The lower rung's bucket the advisor was found in. */
  to: Bucket;
  rungsDropped: number;
  /** Who the hold is recorded as made by: the sweep's actor, or null for a system sweep. */
  createdBy: string | null;
}

/**
 * Move a covered call into the lower rung's bucket its new advisor was found in (#3485
 * Part 1), through Reroute's own machinery rather than a second copy of it: the bucket
 * aware swap moves an advisor only on a claimed, live hold for this booking, this advisor
 * and this bucket, so the move holds, claims, then swaps. The swap rewrites the booking's
 * bucket and routing trace, records the drop, and writes the `rerouted` routing decision,
 * exactly as a manager's reroute does.
 *
 * Every failure THROWS, so the bulk engine retries the item and settles it `failed` after
 * its attempt cap, the same path as any reassign that errored. Once a hold exists, any
 * failure lets it go first, so a failed move never leaves the advisor blocked for leads
 * until the hold runs out; a release that fails too is reported, and never hides the error
 * that caused it.
 */
export async function moveCoverageAcrossBuckets(deps: CascadeMoveDeps, move: CascadeMove): Promise<void> {
  const { booking, from, to } = move;
  const placed = await deps.placeHold({
    orgId: booking.org_id,
    bookingId: booking.id,
    agentUserId: move.agentUserId,
    requestedBucketId: from.id,
    targetBucketId: to.id,
    rungsDropped: move.rungsDropped,
    createdBy: move.createdBy,
  });
  if (!placed.placed) {
    throw new Error(`the advisor could not be held for a move into ${to.code} (${placed.refused})`);
  }
  try {
    const claim = await deps.claimHold(booking.org_id, booking.id, placed.holdId);
    if (claim.refused) throw new Error(`the hold for a move into ${to.code} could not be claimed (${claim.refused})`);
    await deps.reassign(booking.id, move.agentEmail, {
      holdId: placed.holdId,
      bucketId: to.id,
      requestedBucketId: from.id,
      requestedTier: tierKeyOf(from.code),
      bookedTier: tierKeyOf(to.code),
      rungsDropped: move.rungsDropped,
      fromBucketId: from.id,
    });
  } catch (err) {
    await Promise.resolve()
      .then(() => deps.releaseHold(booking.id))
      .catch((releaseErr: unknown) => deps.onReleaseFailed(booking.id, releaseErr));
    throw err;
  }
}
