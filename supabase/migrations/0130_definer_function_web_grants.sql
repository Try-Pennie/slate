-- #2447: let the monitor lane ask the DATABASE which definer functions the web roles can
-- execute.
--
-- `scripts/test-migration-grants.ts` (#2391) proves that every SECURITY DEFINER function
-- defined in a migration revokes EXECUTE from public, anon and authenticated. It reads the
-- repository, so it is blind to the two cases only the live database knows about: a grant
-- made by hand, and a definer function that appears in no migration at all. Production holds
-- one of the second kind (Supabase's own rls_auto_enable, measured 2026-09-16), which is not
-- reachable over PostgREST but is proof that the repository and the database can disagree
-- with nothing noticing (L58).
--
-- Deliberately SECURITY INVOKER. It reads pg_proc and pg_namespace, which every role may
-- read, so it needs no elevation, and a definer function here would add a row to the very
-- list it exists to report on.
--
-- It returns a row per function rather than a verdict. Which functions are excused, and on
-- what grounds, is decided in `src/lib/monitor/definer-grants.ts` where the reason can be
-- written beside the name and driven by a test, rather than in a WHERE clause nobody reads
-- (L129).
--
-- search_path is pinned per the repo rule. Everything it names is in pg_catalog, which the
-- pin includes, so the pin reaches all of it (#1126).
create or replace function definer_function_web_grants()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'name', q.name,
        'args', q.args,
        'returns', q.returns,
        'anon_execute', q.anon_execute,
        'authenticated_execute', q.authenticated_execute
      )
      order by q.name
    ),
    '[]'::jsonb
  )
  from (
    select
      p.proname                                              as name,
      pg_get_function_identity_arguments(p.oid)              as args,
      pg_get_function_result(p.oid)                          as returns,
      has_function_privilege('anon', p.oid, 'EXECUTE')          as anon_execute,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
  ) q;
$$;

-- Deny-all by default, matching every other function the server calls. This one reports on
-- the privilege model, so a web role able to read it would be told exactly which function to
-- aim at.
revoke execute on function definer_function_web_grants()
  from public, anon, authenticated;

comment on function definer_function_web_grants() is
  '#2447: every SECURITY DEFINER function in public with whether anon and authenticated hold EXECUTE, for the monitor lane to judge.';
