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
import { retryTransient, type RetryResult } from "../lib/retry.ts";
import { burstRequestsPerDriver, chooseBurstSlots, type BurstCapacity, type BurstKind, type BurstPlan, type PlannedBurst } from "./book-plan.ts";

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
 * #3565: the fewest advisors one refusal crowd of each run may meet free across its ladder.
 * The case the whole ladder release (#3529) exists for is many free over several rungs, and
 * it is the one that failed (14 free on run 37871606406: all booked, 85 told to retry); a
 * slot with 3 free passes without reaching it. Ten was the first floor, and run 37960351698's
 * seed offered no slot with ten on the sixteen advisor ladder (twelve meetings a day each,
 * five zones), so the hard crowd takes the slot with the MOST free over this floor
 * (`chooseRefusalSlots`): the hardest crowd the seed offers, every run. Thirteen free is held
 * offline on every run of the suite (`scripts/test-confirm-contention.ts`).
 */
export const HARD_REFUSAL_MIN_FREE = 5;

/** A slot's two free counts when both were measured, or null, so neither is ever judged as a number it is not. */
export function measuredFree(c: { rung0Free: number | null; ladderFree: number | null }): { rung0Free: number; ladderFree: number } | null {
  return typeof c.rung0Free === "number" && typeof c.ladderFree === "number" ? { rung0Free: c.rung0Free, ladderFree: c.ladderFree } : null;
}

/**
 * Why a slot cannot host the hard refusal crowd (#3565), or null when it can: at least `min`
 * free across the ladder, and some of them free only below the requested rung, or nothing
 * walks and the ladder release is never exercised.
 */
export function hardRefusalFit(free: { rung0Free: number; ladderFree: number }, min: number): string | null {
  if (free.ladderFree < min) return `the ladder has ${free.ladderFree} free, under the ${min} the hard refusal crowd needs`;
  if (free.ladderFree <= free.rung0Free) return "every free advisor is on the requested rung, so nobody below it would be walked to";
  return null;
}

/** What the refusal control's choice came to (#3565), one outcome per exit the setup can give. */
export type RefusalChoice<L> =
  | { kind: "chosen"; ladder: L; slots: string[]; shownTiers: [string | null, string | null] }
  /** Availability answered for none of the ladders asked (exit 2, the deployment). */
  | { kind: "unanswered"; reads: string[] }
  /** The ladders answered and no time fits the hard crowd (exit 11, the seed or roster). */
  | { kind: "no-hard-slot"; misses: string[]; reads: string[] }
  /** A hard time was found, and the other refusal crowds could not be spaced from it (exit 3). */
  | { kind: "no-spacing"; reads: string[] };

/**
 * The refusal control's ladder and slots (#3565): the FIRST refusal crowd takes the offered
 * time with the most advisors free across the ladder among those fit for the hard crowd
 * (`hardRefusalFit`), so every run meets the hardest crowd the seed offers; the others take
 * the furthest times at least the gap from it and from each other. Ladders are asked in order and the first that yields a full set wins.
 * The reads are injected, so every outcome is driven offline.
 */
export async function chooseRefusalSlots<L>(
  ladders: readonly L[],
  io: {
    offered(ladder: L): Promise<{ times: string[]; shownTiers: [string | null, string | null] } | { why: string }>;
    free(ladder: L, slot: string): Promise<{ rung0Free: number | null; ladderFree: number | null }>;
    label(ladder: L): string;
  },
  opts: { bursts: number; gapMs: number; toMeasure: number; minFree: number },
): Promise<RefusalChoice<L>> {
  const reads: string[] = [];
  const misses: string[] = [];
  let hardFound = false;
  for (const ladder of ladders) {
    const shared = await io.offered(ladder);
    if ("why" in shared) {
      reads.push(shared.why);
      continue;
    }
    const times = shared.times
      .filter((t) => Number.isFinite(Date.parse(t)))
      .sort((a, b) => Date.parse(b) - Date.parse(a))
      .slice(0, opts.toMeasure);
    // Every time measured, and the one with the most free across the ladder kept (the
    // furthest of equals, as the times run furthest first).
    let hard: string | null = null;
    let most = -1;
    for (const t of times) {
      const free = measuredFree(await io.free(ladder, t));
      const why = free ? hardRefusalFit(free, opts.minFree) : "who is free there was not measured";
      if (why === null && free!.ladderFree > most) {
        hard = t;
        most = free!.ladderFree;
      } else if (why !== null) {
        misses.push(`${io.label(ladder)} at ${t}: ${why}`);
      }
    }
    if (hard === null) continue;
    hardFound = true;
    const apart = shared.times.filter((t) => Number.isFinite(Date.parse(t)) && Math.abs(Date.parse(t) - Date.parse(hard!)) >= opts.gapMs);
    const rest = opts.bursts > 1 ? chooseBurstSlots(apart, opts.bursts - 1, opts.gapMs) : [];
    if (rest !== null) return { kind: "chosen", ladder, slots: [hard, ...rest], shownTiers: shared.shownTiers };
  }
  if (reads.length === ladders.length) return { kind: "unanswered", reads };
  if (!hardFound) return { kind: "no-hard-slot", misses, reads };
  return { kind: "no-spacing", reads };
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
  refusal: { codes: [string, string]; shownTiers: [string | null, string | null]; slots: readonly string[]; capacities: readonly BurstCapacity[] },
  drop: { codes: [string, string]; shownTiers: [string | null, string | null]; slot: string; capacity: BurstCapacity },
): BurstPlan {
  let nextRefusal = 0;
  const bursts = sequence.map((kind, i): PlannedBurst => {
    const startAtMs = moments[i];
    if (startAtMs === undefined) throw new Error(`burst ${i + 1} has no moment`);
    if (kind === "drop") {
      return { kind, codes: drop.codes, shownTiers: drop.shownTiers, slot: drop.slot, startAtMs, perDriver: burstRequestsPerDriver(kind), capacity: drop.capacity };
    }
    const slot = refusal.slots[nextRefusal];
    const capacity = refusal.capacities[nextRefusal];
    nextRefusal += 1;
    if (slot === undefined || capacity === undefined) {
      throw new Error(`burst ${i + 1} is a refusal control and only ${refusal.slots.length} refusal slots were chosen`);
    }
    return { kind, codes: refusal.codes, shownTiers: refusal.shownTiers, slot, startAtMs, perDriver: burstRequestsPerDriver(kind), capacity };
  });
  return { bursts };
}

/**
 * A planner read whose failure is only that the database did not answer in time,
 * as opposed to an answer the planner must refuse on. The app's deadline error
 * reaches the planner wrapped by `unwrap` as plain text, so it is recognised by its
 * own wording (`DeadlineExceededError`, "did not answer within <n>ms").
 */
function isTimedOutRead(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /DeadlineExceededError|did not answer within \d+ms/.test(text);
}

/**
 * Run a read-only planner read, retrying it when it TIMED OUT (#3737). Load run 19
 * ended in setup on one read of the branch that took longer than 15s, before any
 * traffic, at a cost of the whole run. A timed out read is asked again through the
 * shared bounded retry (three attempts, every retry printed through `onRetry`), and
 * running out of attempts is still a failure the caller refuses on. Any OTHER error
 * is thrown at once: it is an answer, and asking again would only delay it.
 */
export async function readRetryingTimeouts<T>(
  read: () => Promise<T>,
  io: { sleep?: (ms: number) => Promise<void>; onRetry: (line: string) => void },
): Promise<RetryResult<T>> {
  return retryTransient<T>({
    run: async () => {
      try {
        return { ok: true, value: await read() };
      } catch (err) {
        if (!isTimedOutRead(err)) throw err;
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    sleep: io.sleep,
    onRetry: ({ attempt, reason, waitMs }) =>
      io.onRetry(`retrying a timed out read after attempt ${attempt}, in ${waitMs}ms: ${reason}`),
  });
}

/**
 * The setup's refusal when the roster and its ladders could not be read (exit 4),
 * worded by cause (L11, #3737): a read that timed out on every attempt is a slow
 * database, and only any other failure points at the branch's credentials.
 */
export function rosterUnreadable(reason: string): string {
  const head = `FAILED: the roster and its ladders could not be measured (${reason}), so no burst can be sized against what its ladder holds.`;
  return isTimedOutRead(reason)
    ? `${head} The branch's database did not answer in time on any attempt; read its logs for what held it, then run again.`
    : `${head} Set the branch's database credentials.`;
}
