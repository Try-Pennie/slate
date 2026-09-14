/**
 * How many agents each bucket code's pool resolves to (#2278).
 *
 * The one implementation, because two copies of "how deep is this pool" drift and
 * the drift is silent: the exported roster shape and the burst's own choice of
 * code would then disagree about the same roster while each read as correct (L41).
 *
 * It answers through the booker's OWN predicate rather than reimplementing the
 * match, so the number is the one the booker would produce (L107).
 */
import { agentIdsFromPool } from "@/lib/availability/pool";
import type { Attributes, Criteria } from "@/lib/db/types";
import type { PoolDepth } from "./burst-target.ts";

export function poolDepthsFrom(input: {
  agents: { id: string; attributes: Attributes | null }[];
  buckets: { id: string; code: string; criteria: Criteria | null }[];
  /** Hand named members, which are matched too and would under-report depth if dropped. */
  members: { bucket_id: string; user_id: string }[];
}): PoolDepth[] {
  const membersByBucket = new Map<string, Set<string>>();
  for (const m of input.members) {
    const set = membersByBucket.get(m.bucket_id) ?? new Set<string>();
    set.add(m.user_id);
    membersByBucket.set(m.bucket_id, set);
  }
  const agents = input.agents.map((a) => ({ id: a.id, attributes: a.attributes ?? {} }));
  return input.buckets.map((b) => ({
    code: b.code,
    depth: agentIdsFromPool(agents, membersByBucket.get(b.id) ?? new Set(), b.criteria ?? {}).length,
  }));
}
