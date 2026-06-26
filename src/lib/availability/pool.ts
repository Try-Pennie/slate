import { matchesCriteria } from "./match.ts";
import type { Attributes, Criteria } from "@/lib/db/types";

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
