import { matchesCriteria } from "./match.ts";
import { applyFallback } from "./roundrobin.ts";
import { lowCarrierIds } from "./low-exclusion.ts";
import type { Attributes, Criteria } from "@/lib/db/types";

/**
 * Who a bucket routes to, from rows already read (#3324): the matched pool (manual
 * members and criteria), or the fallback agent when that is empty and they are
 * still routable, plus which of them carry Low (#2842).
 *
 * The one judge `eligibleAgentIds` and the booked window splice share, so a splice
 * that reads the roster ONCE for every pool an advisor serves cannot route
 * differently from the live read (L41). `orgAgents` must be the bucket's org's
 * bookable, not deactivated advisors, which is also exactly the set a fallback agent
 * must be in to be routable: a stored `fallback_user_id` can point at somebody who
 * has since been turned off, and they are never handed a booking.
 */
export function eligibleFromRoster(
  bucket: { criteria: Criteria | null; fallback_user_id: string | null },
  orgAgents: { id: string; attributes: Attributes }[],
  manualMemberIds: Set<string>,
): { ids: string[]; fallbackApplied: boolean; lowIds: string[] } {
  const matched = agentIdsFromPool(orgAgents, manualMemberIds, bucket.criteria ?? {});
  const fallback = bucket.fallback_user_id;
  const r = applyFallback(matched, fallback, fallback !== null && orgAgents.some((a) => a.id === fallback));
  const low = new Set(lowCarrierIds(orgAgents));
  return { ...r, lowIds: r.ids.filter((id) => low.has(id)) };
}

/** Pure: the eligible ids from a resolved pool (manual member OR criteria match). */
export function agentIdsFromPool(
  orgAgents: { id: string; attributes: Attributes }[],
  manualMemberIds: Set<string>,
  criteria: Criteria,
): string[] {
  const hasCriteria = Object.keys(criteria ?? {}).length > 0;
  return orgAgents
    .filter(
      (a) =>
        manualMemberIds.has(a.id) ||
        (hasCriteria && matchesCriteria(a.attributes, criteria)),
    )
    .map((a) => a.id);
}
