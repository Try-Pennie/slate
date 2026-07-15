import { tierLadder } from "./tiers.ts";

/** Outcome of trying one rung: a hit (this tier serves the request) or a drop. */
export type RungOutcome<T> = { hit: true; value: T } | { hit: false };

/**
 * The single ladder-walk BOTH tier cascades are built on (#499): walk the tier
 * ladder for `code`, calling `attempt` for each rung in turn, and return the
 * FIRST rung that hits, with how many rungs were dropped (0 = the requested tier
 * itself). Returns null if no rung hits.
 *
 * `attempt` decides per rung whether this tier can serve the request:
 *   - the display cascade hits when the tier has cached slots,
 *   - the booking cascade hits when an agent verifies free for the slot.
 * An `attempt` that THROWS propagates unchanged (never swallowed as a drop), so a
 * transient outage can't masquerade as an intentional tier-drop.
 *
 * Because both cascades share this walk, they cannot drift on which ladder they
 * use or on the rungs-dropped accounting; only the per-rung `attempt` differs.
 */
export async function walkTierLadder<T>(
  code: string,
  attempt: (rungCode: string, rungIndex: number) => Promise<RungOutcome<T>>,
): Promise<{ value: T; effectiveCode: string; rungsDropped: number } | null> {
  const ladder = tierLadder(code);
  for (let i = 0; i < ladder.length; i++) {
    const outcome = await attempt(ladder[i], i);
    if (outcome.hit) return { value: outcome.value, effectiveCode: ladder[i], rungsDropped: i };
  }
  return null;
}

/**
 * Walk the tier ladder for `code`, calling fetchSlots for each tier in turn.
 * Returns the first tier that has slots, with how many rungs were dropped
 * (0 = the requested tier itself). Returns null if no tier has availability.
 * fetchSlots returns null for a non-existent bucket, which is skipped.
 *
 * Thin wrapper over walkTierLadder: a tier "hits" when it has a non-empty slot
 * list. Shares the ladder walk with the booking cascade so the two never drift.
 */
export async function selectWithTierFallback(
  code: string,
  fetchSlots: (code: string) => Promise<string[] | null>,
): Promise<{ effectiveCode: string; slots: string[]; rungsDropped: number } | null> {
  const winner = await walkTierLadder<string[]>(code, async (rung) => {
    const slots = await fetchSlots(rung);
    return slots && slots.length > 0 ? { hit: true, value: slots } : { hit: false };
  });
  return winner ? { effectiveCode: winner.effectiveCode, slots: winner.value, rungsDropped: winner.rungsDropped } : null;
}
