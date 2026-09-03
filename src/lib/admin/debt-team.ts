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

/**
 * The band ALONE, for the cell that renders off ladder values as their own chips.
 * `debtTeamLabel` carries everything and is what assistive tech and the hover
 * title get; this is what is printed beside the glyph, so the chips are not named
 * twice. Both derive from `bandPhrase`, so the two can never describe the same
 * rungs differently.
 */
export function debtTeamBandLabel(coverage: DebtTeamCoverage): string {
  const { ranks, offLadder } = coverage;
  if (ranks.length === 0 && offLadder.length === 0) return "No team set";
  if (ranks.length === 0) return "";
  return `Covers ${bandPhrase(ranks)}`;
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
 * The whole coverage in words: the band plus anything off the ladder. This is the
 * accessible text and the hover title, so a reader who cannot see the glyph, or
 * who wants it spelled out, gets every stored value in one sentence.
 *
 * A contiguous band reads as a range because that is how a person says it; a gap
 * has to read as a list, because "Low to Ultra High" would be a lie about an
 * agent who does not take the middle.
 */
export function debtTeamLabel(coverage: DebtTeamCoverage): string {
  const { ranks, offLadder } = coverage;
  if (ranks.length === 0 && offLadder.length === 0) return "No team set";

  const band = ranks.length === 0 ? "" : bandPhrase(ranks);
  if (offLadder.length === 0) return `Covers ${band}`;
  const extra = offLadder.join(", ");
  return band ? `Covers ${band}, plus ${extra}` : `Covers ${extra}`;
}
