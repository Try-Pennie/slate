import { BACKEND, DEBT_TIER } from "@/lib/xbc";
import type { Criteria } from "@/lib/db/types";

/**
 * A POOL in words (#2237).
 *
 * Sixty bucket codes route through fifteen pools, so any surface reporting one
 * pool has to say which, and no single code can: six codes share the Low pool
 * and none of them is its name. The name comes from the CRITERIA, which is what
 * a pool actually is, rather than from one member's code or its stored bucket
 * name (which carries a legal digit that stopped routing in #2218 and would name
 * one sixth of the pool).
 *
 * Spelled through `DEBT_TIER` and `BACKEND`, which is where the bucket names,
 * the roster's debt team column and the seeder already take their labels, so one
 * meaning never picks up a second spelling (L41, L118). Changing a label there
 * changes it here.
 *
 * A pool with no `backend_service` is named by its tier alone, and that is
 * correct rather than incomplete: backend digits 0 (None) and 1 (Both) both
 * leave the criterion unset, so the pool genuinely covers any backend. Its
 * member codes are what say so, and every surface that shows a name shows them
 * beside it.
 */

/** key -> label, built from the routing vocabulary rather than restated beside it. */
const TIER_LABEL_BY_KEY = new Map(
  Object.values(DEBT_TIER).map((t) => [t.key, t.label]),
);
const BACKEND_LABEL_BY_KEY = new Map(
  Object.values(BACKEND)
    .filter((b): b is { key: string; label: string } => b.key !== null)
    .map((b) => [b.key, b.label]),
);

/** The criteria keys this can name. Anything else means the label would describe
 *  less than the pool selects, so there is no label (L11). */
const NAMEABLE = new Set(["debt_team", "backend_service"]);

/**
 * The pool's name, or `null` when these criteria are not the routing matrix.
 *
 * Null rather than a best effort, on purpose. A hand made bucket can carry any
 * criteria, and a name assembled from the half this understands would read as a
 * complete description of a pool that also filters on something it never
 * mentioned. Every caller has a surface of its own for the unnamed case: the
 * bucket's own name, or its codes.
 */
export function poolLabel(criteria: Criteria | null): string | null {
  if (!criteria) return null;
  const keys = Object.keys(criteria);
  if (keys.length === 0) return null;
  if (keys.some((k) => !NAMEABLE.has(k))) return null;

  const team = criteria.debt_team;
  if (typeof team !== "string") return null;
  const tier = TIER_LABEL_BY_KEY.get(team);
  if (!tier) return null;

  if (!("backend_service" in criteria)) return tier;
  const backend = criteria.backend_service;
  if (typeof backend !== "string") return null;
  const backendLabel = BACKEND_LABEL_BY_KEY.get(backend);
  if (!backendLabel) return null;
  return `${tier} with ${backendLabel}`;
}

export interface LabelledPool {
  label: string | null;
  codes: string[];
}

/**
 * Pools that render the SAME name, grouped by it.
 *
 * The labels are derived from a routing vocabulary that gets edited for reasons
 * nothing to do with this, so two tiers could come to share a label and nothing
 * would fail: every page would render, every test about one label would pass,
 * and two distinct pools would silently read as one on every surface at once.
 * The same shape as `collidingRungLetters`, for the same reason.
 *
 * Pools with NO name have not collided: neither of them has a name to share, and
 * reporting them would turn "we cannot name this" into a fault.
 */
export function collidingPoolLabels(
  pools: LabelledPool[],
): { label: string; codes: string[] }[] {
  // Grouped by label, counting POOLS rather than codes: one pool holding six
  // codes is the normal case, not a collision.
  const byLabel = new Map<string, { pools: number; codes: string[] }>();
  for (const pool of pools) {
    if (pool.label === null) continue;
    const group = byLabel.get(pool.label);
    if (group) {
      group.pools++;
      group.codes.push(...pool.codes);
    } else {
      byLabel.set(pool.label, { pools: 1, codes: [...pool.codes] });
    }
  }
  return [...byLabel.entries()]
    .filter(([, group]) => group.pools > 1)
    .map(([label, group]) => ({ label, codes: group.codes }));
}
