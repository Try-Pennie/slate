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
