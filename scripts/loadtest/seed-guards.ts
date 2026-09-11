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

/**
 * Why the branch's applied migrations could not be read, or null (#2261).
 *
 * The read goes through the `applied_migration_versions()` RPC, never the table.
 * PostgREST exposes the `public` schema ONLY, so
 * `supabase_migrations.schema_migrations` is unreachable over the API and answers
 * 406 on every project; migration 0072 records that and ships the function for
 * exactly this. The seed shipped reading the table and died on its own check
 * before writing a row, which looks identical to the bad schema the check exists
 * to catch.
 *
 * Each status gets its own sentence, because they send different people to
 * different places (L11): a 404 is a branch missing migration 0072, a 401 or 403
 * is a key that may not call a function granted to the secret key client alone,
 * and anything else is the read itself.
 */
export function migrationReadRefusal(status: number, bodyText: string): string | null {
  if (status === 200) return null;
  const tail = bodyText.trim() === "" ? "" : ` ${bodyText.slice(0, 200)}`;
  if (status === 404) {
    return (
      `applied_migration_versions() answered 404${tail}. Migration 0072 is not applied to this ` +
      `branch, so its schema cannot be checked and the seed refuses.`
    );
  }
  if (status === 401 || status === 403) {
    return (
      `applied_migration_versions() answered ${status}${tail}. Execute on it is granted to the ` +
      `secret key server client only, so this key may not call it.`
    );
  }
  if (status === 406) {
    return (
      `applied_migration_versions() answered 406${tail}. A 406 is what reading ` +
      `supabase_migrations directly gives, so something is calling the table rather than the RPC.`
    );
  }
  return (
    `could not read the branch's applied migrations (${status}${tail}). The seed refuses to run ` +
    `against a schema it cannot check.`
  );
}

/**
 * The applied versions out of the RPC's answer, or a refusal.
 *
 * An answer that is not an array is NOT an empty branch. Reading it as one would
 * hand `migrationMismatch` a count of zero, which it reports as "never migrated or
 * the migration table could not be read": a true sentence about the wrong thing,
 * pointing at the branch when the fault is the function.
 */
export function appliedVersionsFrom(body: unknown): { versions: string[] } | { why: string } {
  if (!Array.isArray(body)) {
    return {
      why:
        "applied_migration_versions() did not return an array, so the branch's schema could not " +
        "be checked. Migration 0072 may be unapplied, or something other than the RPC answered.",
    };
  }
  return { versions: body.map((v) => String(v)) };
}
