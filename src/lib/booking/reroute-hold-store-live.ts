import { supabaseAdmin } from "@/lib/supabase/admin";
import { refreshPoolsForAgents } from "@/lib/availability/slot-cache";
import { afterResponse } from "@/lib/after-response";
import type { RerouteHoldStoreDeps } from "./reroute-hold-store.ts";

/**
 * When the refresh after a place or release runs (#3307). Required, so every place
 * that builds these deps decides, and `tsc` names one that does not.
 *
 * - `after-response`: the reroute routes. A manager is waiting on the answer.
 * - `inline`: the self heal lane's expiry sweep, which has no answer to hold up and
 *   runs the refresh inside the lane's own budget, as every other sweep does.
 */
export type HoldRefreshTiming = "after-response" | "inline";

/**
 * The real database calls behind `reroute-hold-store.ts` (#3248). Kept apart so the
 * logic there is driven by fakes in the node suite. The refresh is the shared
 * every minute shape (`refreshPoolsForAgents`), which never throws: a refresh that
 * fails is caught up by the recompute lane.
 *
 * Build these once per request: on a request path every refresh asked for while it
 * is being answered is gathered into one job that runs after the response.
 */
export function rerouteHoldStoreDeps(label: string, refresh: HoldRefreshTiming): RerouteHoldStoreDeps {
  // The client is made at CALL time, never here, so building the deps cannot throw
  // outside the caller's failure boundary (the self heal lane wraps each sweep in
  // its own catch, L73).
  const db = () => supabaseAdmin();
  return {
    placeRpc: (args) => db().rpc("place_reroute_hold", args),
    deleteUnconsumed: (bookingId) =>
      db()
        // cap-safe: booking_id is unique on reroute_holds, so this deletes at most one row.
        .from("reroute_holds")
        .delete()
        .eq("booking_id", bookingId)
        .is("consumed_at", null)
        .select("agent_user_id"),
    pruneRpc: () => db().rpc("prune_expired_reroute_hold_blocks"),
    refreshPools:
      refresh === "inline"
        ? async (userIds) => {
            await refreshPoolsForAgents(userIds, label);
          }
        : refreshAfterResponse(label),
  };
}

/**
 * The refresh for a request path (#3307): handed to `afterResponse`, so the answer
 * goes back as soon as the hold row is written or deleted.
 *
 * Awaited, it held Find an advisor for 23.8 and 25.5 seconds in production on
 * 2026-10-05 (`touched pools recomputed ... refreshed=5 deferred=1`, five pools at
 * about four seconds each), past the panel's 20 second abort, so a hold that had
 * been placed read as "could not reach the server" and its advisor sat held with
 * nobody able to confirm them.
 *
 * What moving it gives up is slight, and here is why. The refresh changes only the
 * cached slot rows the booker OFFERS. Whether a lead can actually be booked onto a
 * held advisor never depended on it: the hold's busy block is written by a trigger
 * in the same statement that places the hold (migration 0167), the booker skips a
 * held advisor before it sends an invite, and the bookings trigger refuses a
 * booking onto one (migration 0166). And the offer was stale for just as long
 * before: the refresh started the moment the hold was written either way, and the
 * answer used to wait for it to finish. Now it starts a moment later, once the
 * response has gone. A lead who picks a time only the held advisor could serve
 * meanwhile is told it has gone at confirm, like any time taken since the last
 * refresh. The refresh is bounded to fit Cloudflare's 30 second cut after the
 * response (at most `MAX_TOUCHED_POOLS_PER_SWEEP` pools, none started after
 * `TOUCHED_POOLS_BUDGET_MS`), and whatever it does not reach, or a cut that does
 * land, is caught by the every minute recompute lane.
 *
 * Every refresh one request asks for is gathered into ONE job. A confirm whose
 * advisor was taken releases one hold and places another, and two jobs would run
 * side by side (Next starts every `after()` callback together), each with its own
 * five pool allowance inside the same 30 seconds; one job refreshes the union
 * within one allowance. A refresh asked for after the job has started begins a
 * new one, so nothing asked for is dropped.
 */
function refreshAfterResponse(label: string): (userIds: string[]) => Promise<void> {
  let pending: Set<string> | null = null;
  return async (userIds) => {
    if (pending) {
      for (const id of userIds) pending.add(id);
      return;
    }
    const batch = new Set(userIds);
    pending = batch;
    afterResponse("reroute-hold-refresh", async () => {
      // Closed before the refresh starts, so a later ask begins a new job rather
      // than joining one whose list has already been read.
      if (pending === batch) pending = null;
      await refreshPoolsForAgents([...batch], label);
    });
  };
}
