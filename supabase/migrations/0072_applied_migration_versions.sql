-- #814: the prod migration-lag watch (#516) compared only the HIGHEST applied
-- migration against the highest shipped, so a migration missing from the MIDDLE of
-- the sequence (an earlier one never recorded while later ones applied) left the
-- max unchanged and the check read "in-sync". That is exactly the #214 incident
-- (0032 unrecorded). Comparing the SET closes the hole and lets the alert name the
-- missing migration, so this replaces the single-value 0071 function with one that
-- returns the full applied set.
--
-- Same access model as 0071: PostgREST only exposes the `public` schema, so
-- supabase_migrations is unreachable from the API. A SECURITY DEFINER function is
-- the read path, running as the owner while the grant below keeps every API client
-- except the secret-key server client out. search_path is pinned empty so a
-- search_path attack cannot shadow the table; every reference is fully qualified.
--
-- Only this repo's own NNNN numbering counts. A migration applied out of band (the
-- Supabase MCP tool stamps a 14-digit timestamp version instead of the file's
-- prefix) is filtered out by the `^[0-9]{4}$` guard, so it can neither hide a gap
-- nor pin the check to a false "ahead".
--
-- Purely ADDITIVE: the single-value applied_migration_version() from 0071 is left
-- in place, not dropped. The CI migration-drift gate requires a committed migration
-- to be applied to prod BEFORE its PR merges, so this runs while the old code is
-- still live; dropping the function the old code reads would break its monitor tick
-- for the minutes until the new deploy lands. The old function is orphaned once the
-- new code deploys and is dropped in a follow-up after that.
create or replace function applied_migration_versions()
returns text[]
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(array_agg(version order by version), '{}'::text[])
  from supabase_migrations.schema_migrations
  where version ~ '^[0-9]{4}$';
$$;

-- Deny-all by default; only the secret-key server client may call it.
revoke execute on function applied_migration_versions() from public, anon, authenticated;
