import { DEBT_TIER } from "@/lib/xbc";

/**
 * Debt team as the RANK it actually is (#1796).
 *
 * The roster printed the stored keys as a comma list, "ultra_high, very_high,
 * high, medium". Two things wrong with that. The underscores were never a missing
 * vocabulary: `DEBT_TIER` has paired every key with a label all along, and bucket
 * naming already uses those labels, so one vocabulary had two spellings in one
 * codebase and this column picked the machine one. And the values are rungs 1 to
 * 5 that an agent covers a band of, which a comma list cannot express: you had to
 * decode four words to learn "this agent takes the top four".
 *
 * So this module answers two questions and nothing else: which rungs does this
 * agent cover, and what is that in words. The glyph renders the first, every row
 * carries the second, and both come from here so the shape and the sentence can
 * never disagree.
 *
 * WHAT IS NOT ON THE LADDER IS STILL DATA. `debt_team` is not guaranteed to hold
 * only the five keys: `ultra_high_beyond` appears in the staffing depth tests and
 * `credit` / `medical` in the roster filter ones. A five rung glyph finds no rung
 * for those, and dropping them would make this screen under report an agent's
 * coverage while looking complete, so they come back separately and are shown as
 * stored, unprettified, because the reader needs to see it is a data question and
 * not a formatting bug (L113).
 */

/** The rungs, ascending. Keyed to `DEBT_TIER`, which is the only vocabulary. */
export const DEBT_TEAM_RUNGS = [1, 2, 3, 4, 5] as const;

/** The human label for a rung, from the one place that pairs keys with labels. */
export function debtTeamRungLabel(rank: number): string {
  return DEBT_TIER[String(rank)]!.label;
}

/** What the ledger needs from a tier: a name, and optionally a letter for it. */
export interface RungLetterSource {
  label: string;
  /**
   * The ledger letter, when the label's own initial will not do (#1817). Absent
   * for every tier today; it exists so a clash is resolved HERE, where the
   * vocabulary lives, rather than by renaming a tier the XBC routing contract
   * depends on.
   */
  letter?: string;
}

/**
 * The single letter the ledger draws for a tier: an explicit one when the
 * vocabulary gives it, otherwise the label's initial.
 */
export function rungLetter(tier: RungLetterSource): string {
  return (tier.letter ?? tier.label.charAt(0)).toUpperCase();
}

/** The letter the ledger draws for `rank`. */
export function debtTeamRungLetter(rank: number): string {
  return rungLetter(DEBT_TIER[String(rank)]!);
}

/**
 * What to DO when two rungs draw the same letter, carried with the refusal
 * because a guard that only refuses is a dead end (L109).
 */
export const LETTER_COLLISION_REMEDY =
  "Give one of them an explicit `letter` in DEBT_TIER (src/lib/xbc.ts) rather than renaming a tier: the labels are part of the XBC routing contract that Salesforce and the landing pages share.";

/**
 * Rungs whose ledger letters collide, grouped by the letter (#1817).
 *
 * The letters are DERIVED from the tier names, and `DEBT_TIER` is a routing
 * vocabulary rather than a display table, so its labels get adjusted for reasons
 * that have nothing to do with this column. Two sharing an initial draws two
 * identical letters in fixed positions, which is unreadable as a position marker,
 * and NOTHING would fail: the page renders, every test passes, and the silent
 * branch is indistinguishable from the correct one (L113).
 *
 * Takes the table as an argument so the guard can drive a colliding fixture and
 * watch this refuse, rather than only ever seeing the vocabulary that happens to
 * be fine today.
 */
export function collidingRungLetters(
  tiers: Record<string, RungLetterSource>,
  ranks: readonly number[] = DEBT_TEAM_RUNGS,
): { letter: string; rungs: { rank: number; label: string }[] }[] {
  const byLetter = new Map<string, { rank: number; label: string }[]>();
  for (const rank of ranks) {
    const tier = tiers[String(rank)];
    if (!tier) continue;
    const letter = rungLetter(tier);
    const group = byLetter.get(letter) ?? [];
    group.push({ rank, label: tier.label });
    byLetter.set(letter, group);
  }
  return [...byLetter.entries()]
    .filter(([, rungs]) => rungs.length > 1)
    .map(([letter, rungs]) => ({ letter, rungs }));
}

/** rank by stored key, built from DEBT_TIER rather than restated beside it. */
const RANK_BY_KEY = new Map<string, number>(
  Object.entries(DEBT_TIER).map(([rank, tier]) => [tier.key, Number(rank)]),
);

export interface DebtTeamCoverage {
  /** The rungs covered, ascending. Empty when none of the stored values is one. */
  ranks: number[];
  /** Stored values that are not rungs, deduplicated, in the order stored. */
  offLadder: string[];
}

/**
 * Split an agent's stored teams into rungs and everything else.
 *
 * Matching is on the trimmed, lowercased value and is EXACT: a longer value that
 * merely contains a key (`ultra_high_beyond` contains `ultra_high`) is not that
 * rung, or the glyph would claim coverage the routing rules do not give.
 */
export function debtTeamCoverage(teams: string[]): DebtTeamCoverage {
  const ranks = new Set<number>();
  const offLadder: string[] = [];
  const seen = new Set<string>();

  for (const raw of teams) {
    const key = raw.trim().toLowerCase();
    // A blank is not a team. It must not become an off ladder chip, which would
    // report a data problem that is really an empty string.
    if (key === "") continue;
    if (seen.has(key)) continue;
    seen.add(key);
    const rank = RANK_BY_KEY.get(key);
    if (rank !== undefined) ranks.add(rank);
    // Kept as STORED, not as the lowercased key: the reader is being shown the
    // actual value.
    else offLadder.push(raw.trim());
  }

  return { ranks: [...ranks].sort((a, b) => a - b), offLadder };
}

/** The rungs as a phrase: a range when contiguous, a list when there is a gap. */
function bandPhrase(ranks: number[]): string {
  if (ranks.length === DEBT_TEAM_RUNGS.length) return "every tier";
  if (ranks.length === 1) return debtTeamRungLabel(ranks[0]!);
  if (ranks[ranks.length - 1]! - ranks[0]! === ranks.length - 1) {
    return `${debtTeamRungLabel(ranks[0]!)} to ${debtTeamRungLabel(ranks[ranks.length - 1]!)}`;
  }
  return ranks.map(debtTeamRungLabel).join(", ");
}

/**
 * The coverage as a VALUE: the band plus anything off the ladder, and nothing
 * else (#2120).
 *
 * Dan, looking at the agent page: "make the debt teams full words here so it's
 * clear". The ladder earns its place in a COLUMN, where five fixed positions
 * align down every row and that alignment is the entire argument for drawing a
 * mark rather than writing the words. A single record has no column to align to,
 * so the letters buy nothing there and cost a legend the reader has to go and
 * find.
 *
 * A contiguous band reads as a range because that is how a person says it; a gap
 * has to read as a list, because "Low to Ultra High" would be a lie about an
 * agent who does not take the middle. An off ladder value is shown exactly AS
 * STORED, including its case, because the reader needs to see it is a data
 * question and not a formatting one (L113).
 *
 * `null` when there is nothing to say, deliberately: the surface names that
 * state in its own words, beside whatever its sibling fields call it, and a
 * second wording invented here would put two vocabularies for one meaning on one
 * screen (L118).
 */
export function debtTeamValueText(coverage: DebtTeamCoverage): string | null {
  const { ranks, offLadder } = coverage;
  if (ranks.length === 0 && offLadder.length === 0) return null;

  const band = ranks.length === 0 ? "" : bandPhrase(ranks);
  if (offLadder.length === 0) return band;
  const extra = offLadder.join(", ");
  return band ? `${band}, plus ${extra}` : extra;
}

/**
 * The whole coverage as a SENTENCE: the accessible text and the hover title, so
 * a reader who cannot see the glyph, or who wants it spelled out, gets every
 * stored value in one line.
 *
 * Composed FROM the value above rather than beside it. The roster announces this
 * and the agent page prints the value, and two compositions of one fact drift in
 * the direction nobody notices, because each reads as correct on the screen it is
 * on (L41, L263).
 */
export function debtTeamLabel(coverage: DebtTeamCoverage): string {
  const value = debtTeamValueText(coverage);
  return value === null ? "No team set" : `Covers ${value}`;
}
