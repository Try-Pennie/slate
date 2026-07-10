import type { Attributes, Bucket } from "@/lib/db/types";
import { agentIdsFromPool } from "@/lib/availability/pool";

/**
 * Proactive per-tier staffing depth (#584/#569): how many currently-bookable
 * agents each bucket ("tier") can route to, so a single point of failure (a tier
 * resting on one agent, e.g. Ultra High | Beyond = only Tyler) is visible BEFORE
 * the tier goes empty and trips the reactive availability alarm.
 *
 * Pure and IO-free: the admin page injects the already-loaded roster, active
 * bucket members, and buckets. Depth reuses the SAME resolution the booker uses
 * (`agentIdsFromPool` over bookable + not-deactivated agents, criteria OR active
 * manual member), computed FALLBACK-BLIND: a configured fallback is reported
 * separately but never inflates the depth, so it can't mask a thin tier.
 */

/** none = 0 agents, spof = 1 (single point of failure), thin = 2, ok = 3+. */
export type StaffingFlag = "none" | "spof" | "thin" | "ok";

/** A roster agent as the depth math needs it (subset of `User`). */
export interface StaffingAgent {
  id: string;
  name: string;
  attributes: Attributes;
  bookable: boolean;
  deactivated_at: string | null;
}

/** An active `bucket_members` row (already filtered to active = true by caller). */
export interface ActiveMember {
  bucket_id: string;
  user_id: string;
}

export interface TierDepth {
  code: string;
  name: string;
  /** Count of currently-bookable eligible agents, fallback-blind (roster snapshot). */
  depth: number;
  /** Roster depth minus the eligible agents who are out today: an approved
   *  time-off request (#738) or an all-day block on their own calendar (#744).
   *  Equals `depth` when no `outUserIds` are supplied. The short-term risk number. */
  effectiveDepth: number;
  /** How many of the tier's eligible agents are out today (`depth - effectiveDepth`). */
  outCount: number;
  /** Display name of the only agent when depth === 1, else null. */
  soleAgentName: string | null;
  /** True when the bucket has a fallback that itself points at a routable agent. */
  hasWorkingFallback: boolean;
  /** Flag on the roster `depth` (the structural snapshot). */
  flag: StaffingFlag;
  /** Flag on `effectiveDepth` (the time-off-aware short-term risk). */
  effectiveFlag: StaffingFlag;
  /** The tier's eligible agents (the drill-down, #740), each marked out-today,
   *  sorted available-first then out, name-ascending. */
  agents: { id: string; name: string; out: boolean }[];
}

/** Only bookable, non-deactivated agents can be routed to (matches
 *  resolveBucketPool's users filter: .eq("bookable", true).is("deactivated_at", null)). */
export function isRoutable(agent: Pick<StaffingAgent, "bookable" | "deactivated_at">): boolean {
  return agent.bookable && agent.deactivated_at === null;
}

export function staffingFlag(depth: number): StaffingFlag {
  if (depth <= 0) return "none";
  if (depth === 1) return "spof";
  if (depth === 2) return "thin";
  return "ok";
}

/**
 * Depth for every non-test bucket, sorted thinnest-first (ties broken by code) so
 * the single points of failure surface at the top of the view.
 */
export function bucketStaffingDepths(
  buckets: Bucket[],
  agents: StaffingAgent[],
  activeMembers: ActiveMember[],
  outUserIds: Set<string> = new Set(),
): TierDepth[] {
  const routable = agents.filter(isRoutable);
  const orgAgents = routable.map((a) => ({ id: a.id, attributes: a.attributes }));
  const routableIds = new Set(routable.map((a) => a.id));
  const nameById = new Map(agents.map((a) => [a.id, a.name]));

  const membersByBucket = new Map<string, Set<string>>();
  for (const m of activeMembers) {
    const set = membersByBucket.get(m.bucket_id) ?? new Set<string>();
    set.add(m.user_id);
    membersByBucket.set(m.bucket_id, set);
  }

  return buckets
    .filter((b) => !b.is_test)
    .map((b) => {
      const manualMemberIds = membersByBucket.get(b.id) ?? new Set<string>();
      // agentIdsFromPool only yields ids present in orgAgents, so a manual member
      // who is non-bookable/deactivated is dropped here exactly as at booking time.
      const ids = agentIdsFromPool(orgAgents, manualMemberIds, b.criteria ?? {});
      const depth = ids.length;
      // Only eligible agents count as "out": an out id outside this tier's pool
      // can't lower its depth.
      const outCount = ids.filter((id) => outUserIds.has(id)).length;
      const effectiveDepth = depth - outCount;
      const agents = ids
        .map((id) => ({ id, name: nameById.get(id) ?? id, out: outUserIds.has(id) }))
        // Available first, then out; name-ascending within each group.
        .sort((a, c) => Number(a.out) - Number(c.out) || a.name.localeCompare(c.name));
      return {
        code: b.code,
        name: b.name,
        depth,
        effectiveDepth,
        outCount,
        soleAgentName: depth === 1 ? (nameById.get(ids[0]) ?? null) : null,
        hasWorkingFallback: !!b.fallback_user_id && routableIds.has(b.fallback_user_id),
        flag: staffingFlag(depth),
        effectiveFlag: staffingFlag(effectiveDepth),
        agents,
      };
    })
    // Sort by the short-term risk first (effective), then roster depth, then code,
    // so the tiers most at risk today surface at the top.
    .sort(
      (a, b) =>
        a.effectiveDepth - b.effectiveDepth || a.depth - b.depth || a.code.localeCompare(b.code),
    );
}
