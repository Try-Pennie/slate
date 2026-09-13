-- #2271: make a replay of this directory into an EMPTY database readable.
--
-- Not one migration before this one grants a table privilege. Production is
-- readable anyway, because Supabase's own default privileges granted the API
-- roles at the moment each object was created, and those default privileges
-- live in the database rather than in this directory. So a replay produces a
-- correct schema and a dead API. Measured on 2026-09-11, on the first branch
-- ever created from these files (#2261): all 119 migrations applied cleanly,
-- the 39 tables and every column were right, and every REST read answered
-- 42501 insufficient_privilege. The symptom points at RLS. The cause is one
-- level below it.
--
-- RLS is still the gate, and this changes nothing about who may see which row.
-- This is the table level GRANT underneath RLS, without which PostgREST cannot
-- reach a row to apply a policy to it.
--
-- IDEMPOTENT AND A NO-OP AGAINST PRODUCTION. Production already holds every
-- grant below (measured 2026-09-11: DELETE, INSERT, REFERENCES, SELECT,
-- TRIGGER, TRUNCATE, UPDATE for anon, authenticated and service_role across
-- all 39 tables it holds). Re-granting a privilege that is already held
-- changes nothing,
-- and ALTER DEFAULT PRIVILEGES replaces the entry for the same role and schema
-- rather than accumulating, so running this twice is the same as running it
-- once.
--
-- One asymmetry worth stating rather than leaving to be discovered: production
-- was measured at 39 tables and this directory declares 38, so production
-- carries at least one table no migration created. A backfill script's snapshot
-- table is what that normally is, and `on all tables in schema public` reaches
-- one of those as well. It changes nothing about who can read a row: the one
-- such table on record (availability_rules_backup_1255, in the roster hours
-- backfill section of docs/migrations-runbook.md) has RLS enabled with no
-- policies, which is default deny.
--
--
-- WHY anon AND authenticated ARE GRANTED HERE RATHER THAN NARROWED
--
-- This migration's job is to make a replay reproduce the environment that
-- works. Narrowing the privilege model in the same change would mean a fresh
-- database differs from production in a SECOND way, and a restore is the worst
-- possible moment to discover that. Supabase Auth and PostgREST use anon and
-- authenticated for the signed in user path (Slate's RLS lets a user read its
-- own row), so removing them risks breaking auth, and nothing here has measured
-- which roles are actually exercised. Narrowing is worth doing as its own
-- deliberate, measured change, which is filed separately and referenced from
-- #2271.
--
--
-- WHY FUNCTIONS ARE NOT BLANKET GRANTED TO anon AND authenticated
--
-- The hand fix that unblocked the branch ran
-- `grant all on all functions in schema public to anon, authenticated,
-- service_role`. That is the one statement here that must NOT be copied.
-- Seventeen statements across migrations 0024 to 0108 deliberately
-- `revoke execute ... from public, anon, authenticated` on SECURITY DEFINER
-- functions that bypass RLS (erase_booking_pii, rate_limit_hit,
-- move_busy_block, reassign_booking_swap, count_bookings_per_local_day and the
-- rest). A blanket grant running after all of them undoes every one of those
-- revokes, which is the opposite of reproducing production: production does not
-- hold those grants, precisely because the revokes ran.
--
-- What production DOES hold, and a replay does not, is service_role's EXECUTE.
-- Those revokes name `public, anon, authenticated` and never service_role, so
-- in production service_role keeps the direct EXECUTE that Supabase's default
-- privileges gave it at creation time. In a replay there is no such direct
-- grant: the function is created with Postgres's own EXECUTE to PUBLIC, the
-- migration's `revoke ... from public` takes it away, and every server side RPC
-- call then fails. Hence the service_role only grant below.
--
-- The DEFAULT privileges further down do include anon and authenticated on
-- functions, and that is deliberate rather than inconsistent: for a function
-- created after this migration, the revoke in its own file runs after the
-- default privilege, so the established pattern keeps working and a function
-- with no revoke ends up exactly as production has it.
--
--
-- WHY THE DEFAULT PRIVILEGES ARE SET FOR TWO ROLES
--
-- ALTER DEFAULT PRIVILEGES is keyed on the role that CREATES the object, and
-- the grants above only reach objects that exist when this migration runs. The
-- default privileges are the half that stops this fix rotting the next time a
-- table is added: without them, migration 0122's table arrives unreadable and
-- nothing says so until the next replay.
--
-- Production's own entries are set for role `postgres`, which is the role
-- `supabase db push` connects as. The branch measured in #2261 nonetheless came
-- up with no grants at all, which means either that branch's creating role is
-- not `postgres` or its default privileges were never set up the way this
-- project's were. Nothing in this repo can tell those two apart without reading
-- a live database, so the block below sets the entries for BOTH `postgres` and
-- whichever role is actually running this migration, skipping either when it
-- does not exist or is not reachable from the current role. When they are the
-- same role it writes the same entry twice, which is a no-op.


-- Every table that exists right now. The privilege list is production's exact
-- set rather than `all`, so a replay onto a newer Postgres (where `all` would
-- also carry MAINTAIN) reproduces what was measured rather than a superset.
grant delete, insert, references, select, trigger, truncate, update
  on all tables in schema public
  to anon, authenticated, service_role;

-- No migration has created a sequence yet (no serial columns anywhere), so this
-- covers nothing today and is here so that the first one is not a special case.
grant usage, select, update
  on all sequences in schema public
  to anon, authenticated, service_role;

-- service_role ONLY. See "why functions are not blanket granted" above: adding
-- anon or authenticated here would undo seventeen deliberate revokes.
grant execute
  on all functions in schema public
  to service_role;


-- Everything created AFTER this migration.
do $$
declare
  target text;
begin
  for target in
    select rolname
    from pg_roles
    where rolname in (current_user, 'postgres')
      and pg_has_role(current_user, oid, 'usage')
  loop
    execute format(
      'alter default privileges for role %I in schema public '
      || 'grant delete, insert, references, select, trigger, truncate, update '
      || 'on tables to anon, authenticated, service_role',
      target);
    execute format(
      'alter default privileges for role %I in schema public '
      || 'grant usage, select, update '
      || 'on sequences to anon, authenticated, service_role',
      target);
    execute format(
      'alter default privileges for role %I in schema public '
      || 'grant execute '
      || 'on functions to anon, authenticated, service_role',
      target);
  end loop;
end
$$;
