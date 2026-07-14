-- #516: let the running server read the highest migration this database has
-- actually applied, so the monitor lane can page when the deployed code ships
-- schema the DB does not have. Deploys do not apply migrations (#482), and that
-- gap has bitten three times: 0032 unrecorded (#214), 0037 unapplied (availability
-- silently went empty, #276), 0055 unapplied (the dead-man's switch sat dormant a
-- whole session, #516). CI guards merge time; this is the missing prod watch.
--
-- PostgREST only exposes the `public` schema, so `supabase_migrations` is
-- unreachable from the API. A SECURITY DEFINER function is the read path: it runs
-- as the owner (which can see the migrations table) while the grant below keeps
-- every API client except the secret-key server client out.
--
-- search_path is pinned empty so a search_path attack cannot shadow the table;
-- every reference is fully qualified.
--
-- Only this repo's own NNNN numbering counts. A migration applied out of band (the
-- Supabase MCP tool stamps a 14-digit timestamp version instead of the file's
-- prefix) would otherwise win max(), parse as a number far larger than any real
-- version, and pin the check to a permanent "database is ahead", which reads as
-- healthy and silences the alert forever. Ignoring those rows means an out-of-band
-- apply makes the check page (loud, wrong-ish) instead of going quiet (silent,
-- wrong), which is the failure direction we want.
create or replace function applied_migration_version()
returns text
language sql
security definer
set search_path = ''
stable
as $$
  select max(version)
  from supabase_migrations.schema_migrations
  where version ~ '^[0-9]{4}$';
$$;

-- Deny-all by default; only the secret-key server client may call it.
revoke execute on function applied_migration_version() from public, anon, authenticated;
