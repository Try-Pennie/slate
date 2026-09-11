/**
 * The refusals the load test seed makes before it writes anything (#2243). Pure,
 * so `scripts/test-loadtest-seed-guards.ts` drives every one of them with no
 * database.
 */

/**
 * Why a branch's schema is not the one this checkout ships, or null when it is.
 *
 * BOTH the count and the highest version, and the count is the half that matters.
 * The migration directory has never been replayed from empty (L570), so a branch
 * can carry the newest file and be missing one in the middle, and every finding of
 * a ten minute run would then be about the schema rather than about the booking
 * path. Comparing only the highest is the check that looks right and passes on the
 * broken case.
 *
 * An EMPTY applied list is its own message rather than an off-by-N: a branch that
 * reports no migrations at all is one whose migration table could not be read, or
 * one that was never migrated, and neither is a count somebody should reason about.
 */
export function migrationMismatch(
  applied: readonly string[],
  shipped: readonly string[],
  shippedVersion: string,
): string | null {
  if (shipped.length === 0) {
    return "this checkout ships no migrations at all, so there is nothing to compare a branch against";
  }
  if (applied.length === 0) {
    return (
      "the branch reports no applied migrations at all, so it was either never migrated or its " +
      "migration table could not be read. The seed refuses either way."
    );
  }
  const highest = [...applied].sort()[applied.length - 1]!;
  if (applied.length !== shipped.length || highest !== shippedVersion) {
    return (
      `the branch has ${applied.length} migrations (highest ${highest}) and this checkout ships ` +
      `${shipped.length} (highest ${shippedVersion}). A run seeded against a different schema ` +
      `measures the schema. Rebase or recreate the branch.`
    );
  }
  return null;
}

/**
 * An agent count that can actually be seeded, or null.
 *
 * `Number(process.env.AGENTS)` is NaN for anything unreadable, and NaN compares
 * false against every threshold, so a guard written as `n <= 0` waves it through
 * and the arithmetic downstream produces a roster of NaN agents with every count
 * reading as a number (L50). Refused by name instead.
 */
export function readAgentCount(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw.trim() === "") return fallback;
  // Matched as DIGITS rather than parsed, for the same reason `readEventTypeId`
  // is: `Number` accepts "1e3", "0x10" and " 12 " and quietly yields 1000, 16 and
  // 12, and no seed command is ever written in any of those. A roster silently
  // sixteen agents deep is worse than a refusal somebody can read.
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
