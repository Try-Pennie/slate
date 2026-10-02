import type { Attributes, Bucket } from "@/lib/db/types";
import { agentIdsFromPool } from "@/lib/availability/pool";
import { poolKeyFor } from "@/lib/availability/pool-key";
import { poolLabel } from "@/lib/availability/pool-label";
import { DEBT_TIER } from "@/lib/xbc";
import { carriesLow } from "@/lib/availability/low-exclusion";
import { rungExcludesLow, tierLadder } from "@/lib/routing/tiers";

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
  /**
   * The POOL this bucket routes through (#2237). Sixty codes resolve to fifteen,
   * so six rows in a tier carry identical numbers by construction and the screens
   * and the staffing notice can report the answers rather than the copies.
   *
   * Required, so `tsc` names every construction site rather than letting one
   * quietly produce rows nothing can group.
   */
  poolKey: string;
  /** The pool in words, or null when its criteria are not the routing matrix. */
  poolLabel: string | null;
  /**
   * Where this pool's leads go when nobody in it can take them (Dan, 2026-10-02).
   *
   * An empty pool does not fail its leads when the routing ladder carries them to
   * a staffed one: a Low Beyond lead with no Beyond advisor is booked with an
   * Achieve advisor. "No eligible agent, so bookings will fail" was the screen
   * reading only the bucket's own fallback agent and none of the ladder.
   *
   * Walked over the router's own ladder (`tierLadder`), skipping on a top tier
   * lead's lower rungs anyone who carries Low, exactly as booking does (#2842).
   * `overflowToday` counts only advisors who are not out today, which is what the
   * staffing page's status reads; `overflowOnRoster` counts the roster, which is
   * what the bucket editor's count reads. Null when the pool is staffed itself
   * (nothing overflows) or when no rung on the ladder has anybody.
   */
  overflowToday: PoolOverflow | null;
  overflowOnRoster: PoolOverflow | null;
}

/** The staffed pool an empty pool's leads go to. */
export interface PoolOverflow {
  /** The first ladder rung that has somebody. */
  code: string;
  /** That rung's pool, so two codes of one pool compare equal. */
  poolKey: string;
  /** That rung's pool in words, or null outside the routing matrix. */
  label: string | null;
}

/**
 * Whether two depth rows carry the same READING, which is what decides whether
 * the codes of a pool may share one row on the tiers page and one line in the
 * staffing notice (#2237).
 *
 * Everything a surface renders, and nothing that identifies WHICH bucket it is:
 * the code and the bucket's own name are exactly what pooling folds. One
 * predicate rather than one per surface, because two would be a difference
 * nothing enforces and the drift would be silent in both directions.
 *
 * Rows of one pool agree by construction, since the pool key covers every input
 * these numbers come from. That is precisely why this has to be capable of
 * saying no: the day it is not true, the screen must show the disagreement
 * rather than pick a winner.
 *
 * The fields are listed rather than walked, so a field added to `TierDepth` does
 * not silently join the comparison without somebody deciding it should.
 */
export function sameTierReading(a: TierDepth, b: TierDepth): boolean {
  return (
    a.depth === b.depth &&
    a.effectiveDepth === b.effectiveDepth &&
    a.outCount === b.outCount &&
    a.flag === b.flag &&
    a.effectiveFlag === b.effectiveFlag &&
    a.soleAgentName === b.soleAgentName &&
    a.hasWorkingFallback === b.hasWorkingFallback &&
    a.overflowToday?.poolKey === b.overflowToday?.poolKey &&
    a.overflowOnRoster?.poolKey === b.overflowOnRoster?.poolKey &&
    a.agents.length === b.agents.length &&
    a.agents.every((agent, i) => {
      const other = b.agents[i]!;
      return agent.id === other.id && agent.out === other.out;
    })
  );
}

/**
 * What catches an empty pool's leads TODAY, in the order routing tries it: the
 * bucket's own fallback agent first, then the ladder (Dan, 2026-10-02). Null when
 * the pool has somebody available today, so nothing needs catching. One rule, so
 * a screen's pill, counts and sentence cannot disagree about the same row.
 */
export type EmptyPoolCover = "fallback" | "overflow" | "none";

export function emptyPoolCover(row: TierDepth): EmptyPoolCover | null {
  if (row.effectiveDepth > 0) return null;
  if (row.hasWorkingFallback) return "fallback";
  return row.overflowToday ? "overflow" : "none";
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

  const attributesById = new Map(agents.map((a) => [a.id, a.attributes]));

  const rows = buckets
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
        // The same key the recompute lane groups on, so the two can never
        // disagree about which codes are one pool. Manual members are part of it
        // because they genuinely change who a bucket routes to, and since #2253
        // every surface builds the key over the same inputs.
        poolKey: poolKeyFor({
          orgId: b.org_id,
          eventTypeId: b.event_type_id,
          criteria: b.criteria ?? null,
          fallbackUserId: b.fallback_user_id,
          memberIds: [...manualMemberIds],
        }),
        poolLabel: poolLabel(b.criteria ?? null),
        overflowToday: null as PoolOverflow | null,
        overflowOnRoster: null as PoolOverflow | null,
      };
    });

  // Second pass, once every row exists, because a rung is another bucket's row.
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const overflowFor = (code: string, todayOnly: boolean): PoolOverflow | null => {
    for (const rung of tierLadder(code).slice(1)) {
      const target = byCode.get(rung);
      if (!target) continue;
      const people = target.agents.filter(
        (a) =>
          (!todayOnly || !a.out) &&
          !(rungExcludesLow(code, rung) && carriesLow(attributesById.get(a.id))),
      );
      if (people.length > 0) {
        return { code: rung, poolKey: target.poolKey, label: target.poolLabel };
      }
    }
    return null;
  };
  for (const r of rows) {
    if (r.effectiveDepth === 0) r.overflowToday = overflowFor(r.code, true);
    if (r.depth === 0) r.overflowOnRoster = overflowFor(r.code, false);
  }

  // Sort by the short-term risk first (effective), then roster depth, then code,
  // so the tiers most at risk today surface at the top.
  return rows.sort(
    (a, b) =>
      a.effectiveDepth - b.effectiveDepth || a.depth - b.depth || a.code.localeCompare(b.code),
  );
}

/**
 * Depth per DEBT TIER, rolled up from the per pool rows (#2505).
 *
 * The thin whisper used to name every thin POOL, so a Beyond pool sitting at one
 * agent was named daily while its debt tier held eighty four people and every
 * lead asking for it was served. Since #2486 the ladder tries every bucket in the
 * tier before dropping one, so a thin pool inside a staffed tier strands nobody.
 * The whisper counts tiers now, and the per pool depth stays on `/admin/tiers`,
 * which is the screen somebody goes to in order to look.
 *
 * A tier's depth is the count of DISTINCT agents across its pools, never the sum:
 * the pools overlap heavily (an unconstrained pool contains every Achieve agent
 * in the tier), so adding them would report a tier as several times deeper than
 * it is, and the alarm would go quiet on exactly the thin tiers it exists to name.
 */
export interface DebtTierDepth {
  /** The first XBC digit, "1" to "5". */
  tier: string;
  /** The tier in words, from the shared routing vocabulary. */
  name: string;
  /** Distinct currently-bookable eligible agents across the tier, fallback-blind. */
  depth: number;
  /** Distinct agents minus those out today. The short-term risk number. */
  effectiveDepth: number;
  /** How many of the tier's agents are out today. */
  outCount: number;
  /** Display name of the only agent when depth === 1, else null. */
  soleAgentName: string | null;
  flag: StaffingFlag;
  effectiveFlag: StaffingFlag;
}

/**
 * How thin a whole DEBT TIER counts as, which is NOT the pool scale.
 *
 * `staffingFlag` was fitted to a pool, where one or two agents is the real shape
 * and three is genuinely healthy. Debt tiers are 75 / 66 / 43 / 19 / 5 deep
 * (measured 2026-09-17), so reusing that scale would let Low fall from 75 to 3
 * and still read `ok`, which is a threshold judging a distribution it was never
 * fitted to (L172, L354).
 *
 * The line is drawn where a tier stops being able to absorb ONE absence and a
 * booking: at or below two, a single person being out can empty it, which is the
 * thing worth a nudge. The smallest live tier is Ultra High at 5, so this is
 * silent today and its firing is exercised in the suite rather than by the
 * roster (L1).
 *
 * Deliberately NOT proportional. A percentage of a tier's own size means Low has
 * to lose seventy people before it speaks, and the question being asked is not
 * "has this tier shrunk" but "can it still take a call tomorrow".
 */
export function debtTierFlag(depth: number): StaffingFlag {
  if (depth <= 0) return "none";
  if (depth === 1) return "spof";
  if (depth === 2) return "thin";
  return "ok";
}

/** Roll the per pool rows up to one row per debt tier. */
export function debtTierDepths(depths: TierDepth[]): DebtTierDepth[] {
  const byTier = new Map<string, TierDepth[]>();
  for (const row of depths) {
    // The first digit of a valid XBC code. A row whose code is not one (a hand
    // made bucket) belongs to no debt tier and is left out rather than filed
    // under a digit it does not have.
    if (!/^[1-5][0-3][0-2]$/.test(row.code)) continue;
    const tier = row.code[0]!;
    byTier.set(tier, [...(byTier.get(tier) ?? []), row]);
  }
  const out: DebtTierDepth[] = [];
  for (const [tier, rows] of byTier) {
    // DISTINCT agents, by id, across every pool in the tier.
    const all = new Map<string, { id: string; name: string; out: boolean }>();
    for (const r of rows) for (const a of r.agents) all.set(a.id, a);
    const agents = [...all.values()];
    const depth = agents.length;
    const outCount = agents.filter((a) => a.out).length;
    const effectiveDepth = depth - outCount;
    out.push({
      tier,
      name: DEBT_TIER[tier]?.label ?? tier,
      depth,
      effectiveDepth,
      outCount,
      soleAgentName: depth === 1 ? (agents[0]?.name ?? null) : null,
      flag: debtTierFlag(depth),
      effectiveFlag: debtTierFlag(effectiveDepth),
    });
  }
  // Thinnest first, so the tier in most trouble is at the top of the notice.
  return out.sort((a, b) => a.effectiveDepth - b.effectiveDepth || a.tier.localeCompare(b.tier));
}
