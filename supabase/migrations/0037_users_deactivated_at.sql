-- Offboarding lifecycle (#265, Discussion #264): a reversible "this person has
-- left" marker. Nullable; null = active. Deactivate SETS it instead of hard-
-- deleting the row — there are zero FK constraints on public.users (#263), so a
-- delete silently ORPHANS routing/OOO-history rows. All read paths (booking
-- pool, round-robin, sync/watch loop, admin roster, manager picker,
-- impersonation) must exclude non-null. Reactivation (boomerang rehire) sets it
-- back to null — a symmetric flip with no data loss.
alter table public.users
  add column if not exists deactivated_at timestamptz;
