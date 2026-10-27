/**
 * The highest migration version this build ships (#516).
 *
 * The deployed Worker has no filesystem, so it cannot read supabase/migrations at
 * runtime; the version is baked in here instead and compared against what the live
 * database reports it has applied (`applied_migration_version`, migration 0071).
 *
 * BUMP THIS IN THE SAME COMMIT AS EVERY NEW MIGRATION. `scripts/test-migrations.ts`
 * fails (in CI and on pre-push) when it does not match the highest migration file,
 * because a stale constant would make prod look in sync while it is behind, which
 * is precisely the false confidence the lag alert exists to remove.
 */
export const SHIPPED_MIGRATION_VERSION = "0211";
