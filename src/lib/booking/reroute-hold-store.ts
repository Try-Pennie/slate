/**
 * Placing, releasing and expiring a reroute hold (#3248, phase 2 of #3244).
 *
 * The busy block a hold puts in the slot cache is written and removed by triggers
 * on `reroute_holds` (migration 0167), so no path can forget it. What this module
 * adds is the step after each change: the held advisor's buckets are refreshed, so
 * the offer stops showing a time only they could serve while held, and shows it
 * again once they are free.
 *
 * Every database answer is checked: a failed placement, release or sweep THROWS
 * rather than reading as "refused", "nothing held" or "nothing expired" (L105).
 * The routes that call place and release arrive in phase 3 (#3249); the sweep runs
 * on the every minute self heal lane.
 */
import type { PlaceRerouteHoldRefusal } from "../db/reroute-hold-refusals.ts";

type DbAnswer<T> = { data: T[] | null; error: { message: string } | null };

/** The database calls and the refresh, injected so the logic is testable. */
export interface RerouteHoldStoreDeps {
  placeRpc(args: {
    p_org_id: string;
    p_booking_id: string;
    p_agent_user_id: string;
    p_requested_bucket_id: string;
    p_target_bucket_id: string;
    p_rungs_dropped: number;
    p_created_by: string | null;
  }): PromiseLike<DbAnswer<{ hold_id: string | null; expires_at: string | null; refused: PlaceRerouteHoldRefusal | null }>>;
  /** Delete the booking's UNCONSUMED hold, returning the advisor it held. */
  deleteUnconsumed(bookingId: string): PromiseLike<DbAnswer<{ agent_user_id: string }>>;
  pruneRpc(): PromiseLike<DbAnswer<{ user_id: string }>>;
  /** Refresh the buckets these advisors serve. Never throws (the recompute lane backstops). */
  refreshPools(userIds: string[]): Promise<void>;
}

export interface PlaceRerouteHoldArgs {
  orgId: string;
  bookingId: string;
  agentUserId: string;
  requestedBucketId: string;
  targetBucketId: string;
  rungsDropped: number;
  createdBy: string | null;
}

export type PlaceRerouteHoldResult =
  | { placed: true; holdId: string; expiresAt: string }
  | { placed: false; refused: PlaceRerouteHoldRefusal };

function rowsOf<T>(answer: DbAnswer<T>, what: string): T[] {
  if (answer.error) throw new Error(`${what} failed: ${answer.error.message}`);
  return answer.data ?? [];
}

export async function placeRerouteHold(
  args: PlaceRerouteHoldArgs,
  deps: RerouteHoldStoreDeps,
): Promise<PlaceRerouteHoldResult> {
  const rows = rowsOf(
    await deps.placeRpc({
      p_org_id: args.orgId,
      p_booking_id: args.bookingId,
      p_agent_user_id: args.agentUserId,
      p_requested_bucket_id: args.requestedBucketId,
      p_target_bucket_id: args.targetBucketId,
      p_rungs_dropped: args.rungsDropped,
      p_created_by: args.createdBy,
    }),
    "place_reroute_hold",
  );
  const row = rows[0];
  if (!row) throw new Error("place_reroute_hold returned no row");
  if (row.refused) return { placed: false, refused: row.refused };
  if (!row.hold_id || !row.expires_at) throw new Error("place_reroute_hold returned neither a hold nor a refusal");
  await deps.refreshPools([args.agentUserId]);
  return { placed: true, holdId: row.hold_id, expiresAt: row.expires_at };
}

/** Release a booking's live hold (Cancel, or the admin walking away). */
export async function releaseRerouteHold(
  bookingId: string,
  deps: RerouteHoldStoreDeps,
): Promise<{ released: boolean }> {
  const rows = rowsOf(await deps.deleteUnconsumed(bookingId), "release reroute hold");
  if (rows.length === 0) return { released: false };
  await deps.refreshPools([...new Set(rows.map((r) => r.agent_user_id))]);
  return { released: true };
}

/** Remove expired holds' blocks; called every minute by the self heal lane. */
export async function sweepExpiredRerouteHoldBlocks(deps: RerouteHoldStoreDeps): Promise<{ freed: number }> {
  const rows = rowsOf(await deps.pruneRpc(), "prune_expired_reroute_hold_blocks");
  if (rows.length > 0) await deps.refreshPools([...new Set(rows.map((r) => r.user_id))]);
  return { freed: rows.length };
}
