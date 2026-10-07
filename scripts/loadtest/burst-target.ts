/**
 * Which ladders the run's bursts fire at, and why (#2278, #3325, #3429).
 *
 * The burst used to aim at the shallowest POOL, because a crowd of a hundred against a
 * pool one agent deep was "exactly one 200 and the rest SLOT_TAKEN" by construction.
 * #3338 made a crowd walk the tier ladder like any confirm (#3437), so that control now
 * rests on the code's whole LADDER rather than its top rung: a hundred confirms at 120,
 * whose lower rungs are the whole Low tier, mostly win, and the refusal path and the
 * line's settle path go untested. So the run fires two kinds of burst, each chosen by
 * measuring the branch's own roster and bucket rows through the booker's own
 * predicates (L107), never from a hand maintained code (#2278):
 *
 * - the REFUSAL control (`refusalLadders`) fires at the ladder whose WHOLE capacity,
 *   the distinct advisors across every rung with the Low exclusion applied, is the
 *   smallest, and only at one genuinely smaller than its crowd. A ladder is a hard
 *   bound on what any slot of it can book, so the crowd outnumbering it means somebody
 *   is refused whatever the slot. No such ladder is a refusal of the setup by name,
 *   never a smaller crowd: "winners equal capacity" is not a bar (L63).
 * - the DROP burst (`dropLadders`) fires at a ladder whose top rung is the shallowest,
 *   which has a rung below it, and which holds at least twice its crowd, at a slot
 *   where the top rung has somebody free and the ladder has room for everyone
 *   (`dropSlotFit`). On a build that walks the ladder every confirm wins.
 *
 * Each burst is split across two codes of ONE fallback ladder, so the shared confirm
 * line is proved across codes and not only within one (#3325).
 *
 * Pure, so `scripts/test-loadtest-burst-target.ts` drives it with no network and no
 * database.
 */
import { ladderGroupOf } from "../../src/lib/booking/line-key.ts";
import { poolKeyFor, type PoolInput } from "../../src/lib/availability/pool-key.ts";
import { eligibleFromRoster } from "../../src/lib/availability/pool.ts";
import { withoutLowCarriers } from "../../src/lib/availability/low-exclusion.ts";
import { rungExcludesLow, tierLadder } from "../../src/lib/routing/tiers.ts";
import type { Attributes } from "../../src/lib/db/types.ts";
import { burstRequestsPerDriver, type BurstCapacity, type BurstKind, type BurstPlan, type PlannedBurst } from "./book-plan.ts";

/** One bucket code and how many agents its pool resolves to. */
export interface PoolDepth {
  code: string;
  depth: number;
}

/** One bucket's pool inputs and its code, as the app's own `listPoolBuckets` reads them. */
export interface PoolRow extends PoolInput {
  code: string;
}

/** A roster agent as the capacity math needs it: bookable, live, not a test agent. */
export interface RosterAgent {
  id: string;
  attributes: Attributes | null;
}

/**
 * Each code's pool key, through the recompute lane's own `poolKeyFor` (#3325), so the
 * burst and the lane cannot disagree about which codes are one pool (L41).
 */
export function poolKeysByCode(rows: readonly PoolRow[]): Map<string, string> {
  return new Map(rows.map((r) => [r.code, poolKeyFor(r)]));
}

/**
 * The fingerprint of `code`'s whole fallback ladder (#3325): exactly the group the
 * confirm path's shared line keys `code` under (`ladderGroupOf`), so the burst picks
 * codes production really puts in one line, by the one definition of that rule (L41).
 * The branch's bucket rows are the whole picture here, so a rung with no bucket is a
 * gap in the ladder (part of its identity), never "not known yet".
 */
export function ladderSignature(code: string, poolKeyByCode: ReadonlyMap<string, string>): string | null {
  return ladderGroupOf(code, (rung) => poolKeyByCode.get(rung) ?? null);
}

/**
 * Every other code whose ladder is the same pools at every rung as `code`'s, in code
 * order (#3325). Measured from the branch's own bucket rows rather than assumed from
 * the legal digit being inert today: a bucket given a hand named member or a fallback
 * advisor changes its pool key and drops out here at once.
 */
export function siblingCodes(code: string, poolKeyByCode: ReadonlyMap<string, string>): string[] {
  const mine = ladderSignature(code, poolKeyByCode);
  if (mine === null) return [];
  return [...poolKeyByCode.keys()]
    .filter((c) => c !== code && ladderSignature(c, poolKeyByCode) === mine)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Who `code`'s ladder can book, from the roster (#3429): the top rung's advisors, and
 * every distinct advisor across the whole ladder.
 *
 * Each rung through the booker's OWN eligibility judge (`eligibleFromRoster`: criteria,
 * hand named members, and the fallback advisor when the criteria match nobody), with
 * the Low exclusion applied on exactly the rungs the booking cascade applies it to
 * (`rungExcludesLow`), so this is the set the cascade could reach rather than a second
 * copy of the rule (L41). A rung with no bucket adds nobody, as the cascade skips it.
 * The agents are the bookable, live, non test roster, which is also the set a fallback
 * advisor must be in to be routable.
 */
export function ladderRosterIds(
  code: string,
  rowsByCode: ReadonlyMap<string, PoolRow>,
  agents: readonly RosterAgent[],
): { rung0: string[]; ladder: Set<string> } {
  const roster = agents.map((a) => ({ id: a.id, attributes: a.attributes ?? {} }));
  const ladder = new Set<string>();
  let rung0: string[] = [];
  for (const [i, rung] of tierLadder(code).entries()) {
    const row = rowsByCode.get(rung);
    if (!row) continue;
    const eligible = eligibleFromRoster(
      { criteria: row.criteria, fallback_user_id: row.fallbackUserId },
      roster,
      new Set(row.memberIds),
    );
    const ids = rungExcludesLow(code, rung) ? withoutLowCarriers(eligible.ids, eligible.lowIds) : eligible.ids;
    if (i === 0) rung0 = ids;
    for (const id of ids) ladder.add(id);
  }
  return { rung0, ladder };
}

/** One ladder a burst could fire at: a code with a sibling sharing its whole ladder. */
export interface LadderCandidate {
  /** The ladder's first code in code order, which names it. */
  code: string;
  /** The next code of the same ladder, which the burst is split with. */
  sibling: string;
  /** How many rungs the ladder has (`tierLadder`). */
  rungs: number;
  /** Advisors the top rung can book, from the roster. */
  rung0Roster: number;
  /** Distinct advisors the whole ladder can book, from the roster: a bound at any slot. */
  ladderRoster: number;
}

/**
 * Every ladder a burst could fire at, ONE per ladder, each named by its first code and
 * paired with its next one in code order, so two runs against one roster split a burst
 * the same way (L419). Siblings resolve to the same pools and offer the same times, so
 * a second pair of one ladder would spend availability reads on an answer already
 * known. A code with no sibling is left out, because a burst on one code never
 * exercises the line ACROSS codes, which is what the split is for.
 */
export function ladderCandidates(rows: readonly PoolRow[], agents: readonly RosterAgent[]): LadderCandidate[] {
  const keys = poolKeysByCode(rows);
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const seen = new Set<string>();
  const out: LadderCandidate[] = [];
  for (const code of [...byCode.keys()].sort((a, b) => a.localeCompare(b))) {
    const signature = ladderSignature(code, keys);
    if (signature === null || seen.has(signature)) continue;
    const sibling = siblingCodes(code, keys).find((c) => c > code);
    if (sibling === undefined) continue;
    seen.add(signature);
    const ids = ladderRosterIds(code, byCode, agents);
    out.push({
      code,
      sibling,
      rungs: tierLadder(code).length,
      rung0Roster: ids.rung0.length,
      ladderRoster: ids.ladder.size,
    });
  }
  return out;
}

/**
 * The ladders a refusal control can fire at, best first (#3429): those that can book
 * somebody and whose WHOLE capacity is smaller than the crowd, smallest first so the
 * crowd outnumbers its capacity by the most, then the fewest rungs (each one a hop a
 * walking follower pays inside the line's wait), then the code (L419).
 */
export function refusalLadders(candidates: readonly LadderCandidate[], crowd: number): LadderCandidate[] {
  return candidates
    .filter((c) => c.ladderRoster >= 1 && c.ladderRoster < crowd)
    .slice()
    .sort((a, b) => a.ladderRoster - b.ladderRoster || a.rungs - b.rungs || a.code.localeCompare(b.code));
}

/**
 * The ladders a drop burst can fire at, best first (#3429): somebody on the top rung to
 * take its last advisor, a rung below to drop to, and room in the whole ladder for at
 * least `headroom` times the crowd. The shallowest top rung first, so the crowd
 * outnumbers it by the most, then the fewest rungs, then the code. A ladder named in
 * `exclude` (the refusal control's) is never one, so the two bursts never share a pool.
 */
export function dropLadders(
  candidates: readonly LadderCandidate[],
  crowd: number,
  headroom: number,
  exclude: readonly string[],
): LadderCandidate[] {
  return candidates
    .filter((c) => !exclude.includes(c.code) && c.rung0Roster >= 1 && c.rungs >= 2 && c.ladderRoster >= headroom * crowd)
    .slice()
    .sort((a, b) => a.rung0Roster - b.rung0Roster || a.rungs - b.rungs || a.code.localeCompare(b.code));
}

/**
 * Who is free at one slot, from the booker's own candidate read on each rung in ladder
 * order (#3429): the top rung's count, and the distinct advisors across every rung. A
 * rung with no bucket is an empty list.
 */
export function ladderFreeFrom(perRung: readonly (readonly string[])[]): { rung0Free: number; ladderFree: number } {
  const all = new Set<string>();
  for (const ids of perRung) for (const id of ids) all.add(id);
  return { rung0Free: perRung[0]?.length ?? 0, ladderFree: all.size };
}

/**
 * Whether a drop burst can fire at a slot, or why not (#3429). Three things, each its
 * own sentence (L11): somebody free on the top rung, so the crowd meets its LAST
 * advisor and the build's rule decides what the rest are told; fewer free there than
 * the crowd, so somebody has to drop; and room across the ladder for `headroom` times
 * the crowd, so a booking made between the plan and the burst cannot turn the drop
 * burst into a refusal.
 */
export function dropSlotFit(
  free: { rung0Free: number; ladderFree: number },
  crowd: number,
  headroom: number,
): string | null {
  if (free.rung0Free < 1) {
    return "the requested rung has nobody free at it, so the crowd would never meet that rung's last advisor";
  }
  if (free.rung0Free >= crowd) {
    return `the requested rung alone has ${free.rung0Free} free, as many as the crowd of ${crowd}, so nobody would need to drop`;
  }
  if (free.ladderFree < headroom * crowd) {
    return `the ladder has ${free.ladderFree} free, under ${headroom} times the crowd of ${crowd}`;
  }
  return null;
}

/**
 * The plan every driver fires (#3429): one burst per entry of the run's sequence, each at
 * its own moment, the refusal bursts taking the refusal slots in order and the drop
 * burst the drop slot, each with its own ladder's two codes, its kind's share and the
 * capacity measured at its own slot. A sequence asking for more slots than were chosen
 * THROWS rather than planning a burst with no slot.
 */
export function assembleBurstPlan(
  sequence: readonly BurstKind[],
  moments: readonly number[],
  refusal: { codes: [string, string]; slots: readonly string[]; capacities: readonly BurstCapacity[] },
  drop: { codes: [string, string]; slot: string; capacity: BurstCapacity },
): BurstPlan {
  let nextRefusal = 0;
  const bursts = sequence.map((kind, i): PlannedBurst => {
    const startAtMs = moments[i];
    if (startAtMs === undefined) throw new Error(`burst ${i + 1} has no moment`);
    if (kind === "drop") {
      return { kind, codes: drop.codes, slot: drop.slot, startAtMs, perDriver: burstRequestsPerDriver(kind), capacity: drop.capacity };
    }
    const slot = refusal.slots[nextRefusal];
    const capacity = refusal.capacities[nextRefusal];
    nextRefusal += 1;
    if (slot === undefined || capacity === undefined) {
      throw new Error(`burst ${i + 1} is a refusal control and only ${refusal.slots.length} refusal slots were chosen`);
    }
    return { kind, codes: refusal.codes, slot, startAtMs, perDriver: burstRequestsPerDriver(kind), capacity };
  });
  return { bursts };
}
