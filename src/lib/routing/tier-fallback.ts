import { tierLadder } from "./tiers.ts";

/**
 * Walk the tier ladder for `code`, calling fetchSlots for each tier in turn.
 * Returns the first tier that has slots, with how many rungs were dropped
 * (0 = the requested tier itself). Returns null if no tier has availability.
 * fetchSlots returns null for a non-existent bucket, which is skipped.
 */
export async function selectWithTierFallback(
  code: string,
  fetchSlots: (code: string) => Promise<string[] | null>,
): Promise<{ effectiveCode: string; slots: string[]; rungsDropped: number } | null> {
  const ladder = tierLadder(code);
  for (let i = 0; i < ladder.length; i++) {
    const slots = await fetchSlots(ladder[i]);
    if (slots && slots.length > 0) {
      return { effectiveCode: ladder[i], slots, rungsDropped: i };
    }
  }
  return null;
}
