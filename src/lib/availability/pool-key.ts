import type { Criteria } from "@/lib/db/types";

/**
 * The POOL a bucket belongs to (#2245): everything about it that can move the
 * slots `getBucketSlots` computes, and nothing else.
 *
 * Sixty bucket codes resolve to fifteen of these. The legal digit stopped
 * routing (#2218) and backend digits 0 (None) and 1 (Both) never set
 * `backend_service` at all, so six codes per tier carry identical criteria and
 * the every minute recompute lane was running the whole multi agent availability
 * compute sixty times to produce fifteen distinct answers.
 *
 * Two buckets sharing a key is a PROMISE that computing either gives the same
 * answer, so the lane may compute once and write both rows. The fields below are
 * therefore the complete set of compute inputs, and the reasoning for each is
 * the reason it is here rather than a matter of taste:
 *
 * - `orgId` bounds which agents are even considered (`resolveBucketPool` reads
 *   the org's bookable agents) and decides whose week gates them.
 * - `eventTypeId` sets duration, buffers, minimum notice, slot interval and the
 *   daily cap, so it shapes every slot even over an identical pool.
 * - `criteria` selects the agents.
 * - `fallbackUserId` is who serves the bucket when the criteria match nobody,
 *   so two buckets alike in every other way can still offer different times.
 * - `memberIds` are the active manual members, unioned into the pool.
 *
 * What is deliberately NOT here: the bucket's own id, code and name. Those are
 * the bucket's IDENTITY rather than an input to the compute, and keeping them
 * out is the entire point. The shared answer is written to each code's row with
 * that code's own identity re attached, so nothing downstream (the routing
 * trace's effective code, the test bucket gate, the empty bucket alert key) ever
 * reads a sibling's.
 *
 * Anything that starts feeding the compute must be added here in the same
 * change, or the lane will serve one pool's times under another pool's code.
 */
export interface PoolInput {
  orgId: string;
  eventTypeId: string;
  criteria: Criteria | null;
  fallbackUserId: string | null;
  /** Active manual members. Order carries no meaning. */
  memberIds: string[];
}

/**
 * The pool's key, stable across reads and readable in a log line.
 *
 * Two canonicalisations, and the asymmetry between them is deliberate.
 *
 * Criteria KEYS are sorted, because PostgREST returns jsonb in stored order and
 * every key must match for an agent to match (`matchesCriteria`), so the order
 * carries no meaning and letting it split a pool would just waste a compute.
 *
 * An array criteria VALUE is left exactly as stored. Sorting it would be correct
 * only if matching ignores the order, and being wrong THAT way merges two pools
 * that route to different people, which is the one failure this key must not
 * have. Being wrong the other way computes one pool twice, which is what the
 * code did everywhere until now.
 *
 * The parts are framed as a JSON array rather than joined with a separator, so
 * no field's content can impersonate the boundary between fields and collide
 * with a different pool.
 */
export function poolKeyFor(input: PoolInput): string {
  const criteria = input.criteria ?? {};
  const canonical = Object.keys(criteria)
    .sort()
    .map((k) => [k, criteria[k]] as const);
  return JSON.stringify([
    "pool:v1",
    input.orgId,
    input.eventTypeId,
    input.fallbackUserId,
    canonical,
    [...input.memberIds].sort(),
  ]);
}

/**
 * The buckets grouped by pool, insertion ordered within each group so a caller
 * that wants a representative gets a stable one rather than whichever the map
 * happened to yield.
 */
export function groupByPool<T extends PoolInput>(buckets: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const b of buckets) {
    const key = poolKeyFor(b);
    const group = out.get(key);
    if (group) group.push(b);
    else out.set(key, [b]);
  }
  return out;
}
