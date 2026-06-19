import { matchesCriteria } from "./match.ts";
import type { Attributes, Criteria } from "@/lib/db/types";

/** The bucket facts needed to decide if an agent affects it (pure, testable). */
export interface BucketForMatch {
  code: string;
  criteria: Criteria;
  /** Active manual members of the bucket. */
  manualMemberIds: string[];
  /** The bucket's fallback agent, if any. */
  fallbackUserId: string | null;
}

/**
 * Codes of the buckets an agent is part of, mirroring `resolveBucketAgentIds`'s
 * eligibility predicate (manual member UNION attribute-criteria match) plus the
 * fallback agent — so a calendar/OOO change for this agent recomputes exactly the
 * buckets whose slots could move. Used by the refresh-on-change writers.
 */
export function bucketsMatchingAgent(
  agentId: string,
  attributes: Attributes,
  buckets: BucketForMatch[],
): string[] {
  return buckets
    .filter((b) => {
      if (b.manualMemberIds.includes(agentId)) return true;
      if (b.fallbackUserId === agentId) return true;
      const hasCriteria = Object.keys(b.criteria ?? {}).length > 0;
      return hasCriteria && matchesCriteria(attributes, b.criteria);
    })
    .map((b) => b.code);
}
