import type { LifecycleAction } from "@/lib/offboarding/plan";

/**
 * Should this lifecycle call move the agent's remaining appointments, and under
 * what key (#1241)?
 *
 * Deactivating an agent and reassigning the appointments they already hold have
 * always been two independent actions. The pool exit cleanup tears down their
 * Google watch and prunes their cached busy time, so they stop being OFFERED, and
 * the confirmed appointments already on their calendar stay with somebody who has
 * left. Until now the only thing that noticed was the `inactive_agent_bookings`
 * monitor, about an hour later, asking a person to run the coverage panel.
 *
 * Automatic HERE and nowhere else. An admin deactivating someone in the admin UI
 * keeps the confirm step, because that action can mean several things and there is
 * a human right there to ask. An API call from the offboarding automation has
 * nobody to ask, exactly like the approved time off case (#1219), so there is no
 * decision to put in front of anyone.
 *
 * Pure so the rule can be read and tested on its own rather than inferred from
 * which function happens to call which.
 */

export interface OffboardingSweepPlan {
  /** The agent who left: whose bookings move. */
  outUserId: string;
  /**
   * The stored `deactivated_at` this sweep covers. It is BOTH the window start
   * (everything still ahead of the moment they left) and the idempotency key,
   * paired with the agent in a unique index.
   *
   * It is the row's stamp, never a fresh clock read, and that is the whole point:
   * a retry of the same offboarding carries the same key and converges onto one
   * sweep, where a key derived from "now" would mint a new one per call and the
   * database constraint would never fire (L186).
   */
  deactivatedAtIso: string;
}

export function planOffboardingCoverageSweep(outcome: {
  action: LifecycleAction;
  /** The user the call resolved to, or null when the email matched nobody. */
  userId: string | null;
  /** The row's `deactivated_at` AFTER the call, or null when they are still active. */
  deactivatedAtIso: string | null;
}): OffboardingSweepPlan | null {
  // Reactivation never sweeps, and never un-sweeps. Appointments moved while the
  // agent was away stay with the agent covering them (#1219): the customer has
  // already been told who they are meeting, and moving them a second time to
  // undo an absence is a worse outcome than the reassignment they accepted.
  if (outcome.action !== "deactivate") return null;
  if (!outcome.userId) return null;

  const stamp = (outcome.deactivatedAtIso ?? "").trim();
  // No stamp means the call did not leave them deactivated (not found, or
  // reactivated underneath us). Nothing to cover, and an empty string is not a
  // key: keying on it would collide every agent onto one row.
  if (!stamp) return null;

  return { outUserId: outcome.userId, deactivatedAtIso: stamp };
}
