import { matchesCriteria } from "../availability/match.ts";
import type { Attributes, Criteria, RoutingExclusion } from "@/lib/db/types";

/**
 * Pure: split a bucket's bookable org pool into the candidates that were
 * considered (eligible AND free for the slot) and the ones excluded, each with
 * a reason. Reuses matchesCriteria so criteria logic is never duplicated.
 *
 * `orgAgents` must already be the bookable, non-deactivated pool (the same set
 * resolveBucketAgentIds queries). `freeIds` is the subset that passed slot
 * availability (freeMembersForSlot output).
 */
export function classifyExclusions(
  orgAgents: { id: string; attributes: Attributes }[],
  manualMemberIds: Set<string>,
  criteria: Criteria,
  freeIds: string[],
): { considered: string[]; excluded: RoutingExclusion[] } {
  const free = new Set(freeIds);
  const hasCriteria = Object.keys(criteria ?? {}).length > 0;
  const considered: string[] = [];
  const excluded: RoutingExclusion[] = [];

  for (const a of orgAgents) {
    const eligible =
      manualMemberIds.has(a.id) || (hasCriteria && matchesCriteria(a.attributes, criteria));
    if (!eligible) {
      excluded.push({ user_id: a.id, reason: "criteria_miss" });
      continue;
    }
    if (free.has(a.id)) considered.push(a.id);
    else excluded.push({ user_id: a.id, reason: "no_availability" });
  }
  return { considered, excluded };
}

/**
 * Pure: a misroute is when the chosen agent does NOT satisfy the bucket
 * criteria AND no intentional fallback explains it. Intentional fallbacks
 * (empty-pool designated agent, or a tier-drop) are expected, not bugs.
 */
export function isMisroute(input: {
  chosenAttributes: Attributes;
  criteria: Criteria;
  emptyPoolFallback: boolean;
  tierFallback: boolean;
}): boolean {
  if (input.emptyPoolFallback || input.tierFallback) return false;
  if (Object.keys(input.criteria ?? {}).length === 0) return false;
  return !matchesCriteria(input.chosenAttributes, input.criteria);
}
