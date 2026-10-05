/**
 * What pool the burst fires at, and how strong that makes the control (#2278).
 *
 * The burst leg fires 100 simultaneous requests at ONE slot, and the control rests
 * on that slot's pool being ONE agent deep: contention across three agents proves
 * much less than contention on one. Nothing measured it. The code was a hand
 * maintained constant, the seeded roster gave it three, and a live run answered
 * three 200s on three different agents, which is correct behaviour and a
 * materially weaker control than the one intended.
 *
 * The constant rots as well as being unmeasured: production's Low plus Beyond pool
 * emptied on 2026-09-10 (#2152) and it had to be moved by hand from 122 to 222 on
 * the morning of the next run (#2319).
 *
 * So the setup MEASURES every pool through the booker's own predicate, asks the
 * shallowest ones what they are offering, fires at the first that offers anything,
 * and reports the depth it actually ran at.
 *
 * Two things this deliberately does NOT do. It never FAILS on depth, because the
 * judge asks one winner per AGENT (#2273), which is the real invariant and holds
 * at any depth, so a run red for a roster with no one deep pool is red for a
 * property of the roster (L36). And an unmeasured depth never renders as a number:
 * "nobody measured it" and "it was one deep" are the two states this exists to
 * tell apart (L98, L11).
 *
 * Pure, so `scripts/test-loadtest-burst-target.ts` drives it with no network and no
 * database.
 */
import { tierLadder, rungExcludesLow } from "../../src/lib/routing/tiers.ts";
import { poolKeyFor, type PoolInput } from "../../src/lib/availability/pool-key.ts";

/** One bucket code and how many agents its pool resolves to. */
export interface PoolDepth {
  code: string;
  depth: number;
}

/** What the run knows about the depth the burst actually ran at. */
export type BurstDepthReading =
  | { measured: true; code: string; depth: number }
  | { measured: false; code: string; why: string };

/**
 * The codes to ask availability about, shallowest pool first.
 *
 * A pool with NOBODY in it is not a candidate: it can never offer a time, so
 * asking spends one of the availability reads the setup has to live inside for
 * nothing, and a run of empty answers would end in the "offered nothing" refusal
 * naming a pool that was never the problem.
 *
 * Ties break on the CODE, so two runs against one roster ask the same question.
 * An order settled by whatever the read happened to return makes the burst a
 * different measurement each time for no reason a reader could see (L419).
 *
 * `limit` is what bounds the availability reads: that endpoint has its own per
 * address ceiling (30 a minute) and the setup shares its address with everything
 * else the job does.
 */
export function burstCandidateOrder(depths: readonly PoolDepth[], limit: number): string[] {
  if (limit <= 0) return [];
  return depths
    .filter((d) => d.depth > 0)
    .slice()
    .sort((a, b) => (a.depth !== b.depth ? a.depth - b.depth : a.code.localeCompare(b.code)))
    .slice(0, limit)
    .map((d) => d.code);
}

/**
 * The sentence the report carries about what this run's burst actually proved.
 *
 * Three readings, never two: one deep, deeper than one, and not measured. The
 * third is the one the issue is about, and it must not be able to render as a
 * number, because a report saying nothing about depth reads exactly like a report
 * about a one deep pool to anybody who knows what the control is for.
 */
export function burstControlStrength(reading: BurstDepthReading): string {
  if (!reading.measured) {
    return (
      `the depth of the burst's pool (${reading.code}) was NOT measured (${reading.why}), so how ` +
      "strong this control was is unknown: contention on one agent and contention spread over " +
      "several are the two things it cannot tell apart"
    );
  }
  if (reading.depth === 1) {
    return (
      `the burst ran against ${reading.code}, a pool 1 agent deep, which is the strongest form of ` +
      "this control: every request after the winner met the same agent"
    );
  }
  return (
    `the burst ran against ${reading.code}, a pool ${reading.depth} agents deep, so contention was ` +
    `spread over ${reading.depth} agents and the control is weaker than a one deep pool would be. ` +
    "The bar itself still holds: it asks for one winner per agent, not one winner"
  );
}

/** One bucket's pool inputs and its code, as the app's own `listPoolBuckets` reads them. */
export interface PoolRow extends PoolInput {
  code: string;
}

/**
 * Each code's pool key, through the recompute lane's own `poolKeyFor` (#3325), so the
 * burst and the lane cannot disagree about which codes are one pool (L41).
 */
export function poolKeysByCode(rows: readonly PoolRow[]): Map<string, string> {
  return new Map(rows.map((r) => [r.code, poolKeyFor(r)]));
}

/**
 * The fingerprint of `code`'s whole fallback ladder (#3325): for every rung the
 * booker walks (`tierLadder`), the pool that rung resolves to and whether a top tier
 * lead skips Low carriers on it (`rungExcludesLow`). Two codes with the same
 * fingerprint send a crowd through the same pools in the same way, which is exactly
 * when the shared confirm line may tell one of them "taken" on the other's verdict.
 *
 * Null when any rung has no bucket: a ladder that cannot be read whole cannot be
 * vouched for, and matching it on the rungs that happen to exist is how two codes
 * that route differently would read as one.
 */
export function ladderSignature(code: string, poolKeyByCode: ReadonlyMap<string, string>): string | null {
  const rungs: [string, boolean][] = [];
  for (const rung of tierLadder(code)) {
    const key = poolKeyByCode.get(rung);
    if (key === undefined) return null;
    rungs.push([key, rungExcludesLow(code, rung)]);
  }
  return JSON.stringify(rungs);
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
 * The code pairs to ask availability about, shallowest pool first (#3325): each code
 * that has at least one sibling, paired with its first sibling in code order so two
 * runs against one roster split the burst the same way (L419). A code with no sibling
 * is skipped rather than fired alone, because a burst on one code never exercises the
 * line ACROSS codes, which is what the split is for.
 *
 * ONE pair per ladder: siblings resolve to the same pools and so offer the same times,
 * and asking a second pair of one ladder would spend two of the bounded availability
 * reads on an answer already known.
 */
export function burstPairOrder(
  depths: readonly PoolDepth[],
  poolKeyByCode: ReadonlyMap<string, string>,
  limit: number,
): { code: string; sibling: string }[] {
  const paired = new Map<string, string>();
  for (const d of depths) {
    const sibling = siblingCodes(d.code, poolKeyByCode)[0];
    if (sibling !== undefined) paired.set(d.code, sibling);
  }
  const ordered = burstCandidateOrder(
    depths.filter((d) => paired.has(d.code)),
    depths.length,
  );
  const seenLadders = new Set<string>();
  const out: { code: string; sibling: string }[] = [];
  for (const code of ordered) {
    if (out.length >= limit) break;
    // Non null: a code is only paired when its ladder has a signature.
    const ladder = ladderSignature(code, poolKeyByCode)!;
    if (seenLadders.has(ladder)) continue;
    seenLadders.add(ladder);
    out.push({ code, sibling: paired.get(code)! });
  }
  return out;
}
