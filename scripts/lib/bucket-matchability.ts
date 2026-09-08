// Who could ANY real bucket actually route to (#2094)?
//
// The roster comparison needs this to tell two states apart: somebody Slate holds
// back who a lead could otherwise reach, which is a page, and somebody no bucket
// can reach whatever their flags say, which is a standing note. It used to ask
// whether they carried any Salesforce attribute at all, which is a proxy for the
// question rather than the question (L63): `rsegui@` carried `{"role":"Sales"}`,
// no bucket keys on `role`, and they were paged on daily.
//
// It answers by calling the SHIPPED pool predicate rather than reimplementing the
// match, because a rule written beside `matchesCriteria` is a second definition
// that drifts, and it drifts in the direction that flatters whoever wrote it (L107).
import { agentIdsFromPool } from "@/lib/availability/pool";
import type { Attributes, Criteria } from "@/lib/db/types";

/**
 * The ids any bucket could put in front of a lead: a criteria match, or a manual
 * membership row, exactly as the booker resolves a pool.
 *
 * Manual members are included because they are matched too, and leaving them out
 * would report somebody a bucket really can reach as unreachable.
 */
export function matchableAgentIds(
  agents: { id: string; attributes: Attributes }[],
  buckets: { criteria: Criteria }[],
  manualMemberIds: Set<string>,
): Set<string> {
  const matchable = new Set<string>();
  for (const bucket of buckets) {
    for (const id of agentIdsFromPool(agents, manualMemberIds, bucket.criteria)) matchable.add(id);
  }
  return matchable;
}
