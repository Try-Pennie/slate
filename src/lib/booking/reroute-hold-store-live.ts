import { supabaseAdmin } from "@/lib/supabase/admin";
import { refreshPoolsForAgents } from "@/lib/availability/slot-cache";
import type { RerouteHoldStoreDeps } from "./reroute-hold-store.ts";

/**
 * The real database calls behind `reroute-hold-store.ts` (#3248). Kept apart so the
 * logic there is driven by fakes in the node suite. The refresh is the shared
 * every minute shape (`refreshPoolsForAgents`), which never throws: a refresh that
 * fails is caught up by the recompute lane.
 */
export function rerouteHoldStoreDeps(label: string): RerouteHoldStoreDeps {
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
    refreshPools: async (userIds) => {
      await refreshPoolsForAgents(userIds, label);
    },
  };
}
