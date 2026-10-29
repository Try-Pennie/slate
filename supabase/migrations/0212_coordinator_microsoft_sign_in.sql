-- #4379: invited scheduling coordinators sign in with their own company Microsoft account.
--
-- Until now every Slate account was a trypennie.com Google account (0159, #3082). The call
-- center partner's coordinators (role `coordinator`, 0209) sign in through Supabase Auth's
-- `azure` provider with their own company addresses instead, and nobody else may. The
-- Email provider stays OFF throughout, and staff stay Google only.
--
-- Rollout, in this order (the pull request says it too): this migration is applied with
-- `supabase db push` before the merge; the code deploys and is confirmed live; only then is
-- the Azure provider switched on in the Supabase dashboard. Rollback is switching it off.
--
-- 1. users.microsoft_sub: the Microsoft account's permanent subject id, recorded when a
--    coordinator's first Microsoft sign in is linked to their row (`linkCoordinator`,
--    src/lib/provision.ts) and compared on every request after (`realCurrentUser`). The
--    Microsoft counterpart of google_sub (#3526): the address finds the row, the subject
--    says whose it is. Unique where set, so one Microsoft account can never hold two rows.
--
-- 2. users_outside_email_is_coordinator: an address outside trypennie.com is a
--    coordinator's, and nobody else's. Staff sign in with Google, and the Google sign in
--    refuses every address outside the Workspace domain, so a staff row on an outside
--    address is one nobody can ever sign in to, and a coordinator row is the only kind
--    the Microsoft sign in may link. The violators are counted first, and the migration
--    fails loudly rather than skipping them (expected 0: every row the Salesforce sync,
--    the sign in and Team access have written is on trypennie.com).
--
-- 3. before_user_created_domain_gate, replaced under the SAME name so the hook the
--    dashboard registers (Authentication, Hooks) keeps pointing at it:
--      - trypennie.com may be created through provider `google` only, decided before any
--        table is read, so a permission fault on the table cannot lock staff out;
--      - provider `azure` only when an active (deactivated_at null), unlinked
--        (auth_user_id null) users row with role `coordinator` holds exactly that
--        lowercased address, which is what Team access writes when it grants one;
--      - everything else is refused, the Email provider included.
--    It reads public.users now, so it is SECURITY DEFINER (its owner reads the table past
--    row level security, which grants supabase_auth_admin nothing on it) and declared
--    STABLE. The search_path stays pinned to pg_catalog and the table is schema qualified
--    (#1126). EXECUTE stays with supabase_auth_admin alone and is taken back from public,
--    anon and authenticated (#2391), so it is never callable over PostgREST.
--
-- 4. auth_logins_by_provider: every sign in Supabase Auth recorded since a moment, by the
--    provider it named, read from auth.audit_log_entries for the monitor lane, which pages
--    on a sign in by any method other than Google or Microsoft (src/lib/monitor/
--    auth-unexpected-sign-ins.ts). It also returns how many entries of ANY kind were written in
--    the window, so "nobody signed in another way" can be told from "nothing is being
--    written to the audit log at all" (L98). SECURITY DEFINER for the same reason as the
--    hook, pinned, EXECUTE taken back from the web roles; service_role keeps it.
--
-- Additive for the deployed code: a new nullable column, a CHECK every existing row
-- satisfies (counted first), and a hook that answers exactly as before for every Google
-- sign in on trypennie.com, which is the only way any account is created today.

-- 1. -----------------------------------------------------------------------------------
alter table public.users add column if not exists microsoft_sub text;

create unique index if not exists users_microsoft_sub_key
  on public.users (microsoft_sub) where microsoft_sub is not null;

comment on column public.users.microsoft_sub is
  'The Microsoft account subject a coordinator signs in with (#4379), recorded at their first Microsoft sign in and compared on every request after. Null for everybody who signs in with Google.';

-- 2. -----------------------------------------------------------------------------------
do $$
declare
  violators bigint;
begin
  select count(*) into violators
  from public.users
  where role <> 'coordinator'
    and coalesce(lower(substring(email from '@([^@]*)$')), '') <> 'trypennie.com';
  raise notice 'users outside trypennie.com that are not coordinators: %', violators;
  if violators > 0 then
    raise exception
      'refusing to add users_outside_email_is_coordinator: % users rows hold an address outside trypennie.com and are not coordinators. Correct those rows first; nothing was changed.',
      violators;
  end if;
end;
$$;

alter table public.users add constraint users_outside_email_is_coordinator
  check (role = 'coordinator' or coalesce(lower(substring(email from '@([^@]*)$')), '') = 'trypennie.com');

comment on constraint users_outside_email_is_coordinator on public.users is
  'An address outside trypennie.com belongs to a scheduling coordinator, who signs in with Microsoft, and to nobody else (#4379).';

-- 3. -----------------------------------------------------------------------------------
create or replace function public.before_user_created_domain_gate(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_email text := lower(trim(coalesce(event->'user'->>'email', '')));
  email_domain text := lower(substring(coalesce(event->'user'->>'email', '') from '@([^@]*)$'));
  v_provider text := coalesce(event->'user'->'app_metadata'->>'provider', '');
begin
  -- Staff: decided here, before any table is read.
  if email_domain is not null and email_domain = 'trypennie.com' then
    if v_provider = 'google' then
      return '{}'::jsonb;
    end if;
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Pennie staff sign in to Slate with their Pennie Google account.'
      )
    );
  end if;

  -- An invited coordinator, on exactly the address they were granted.
  if v_provider = 'azure' and v_email <> '' and exists (
    select 1
    from public.users u
    where u.email = v_email
      and u.role = 'coordinator'
      and u.deactivated_at is null
      and u.auth_user_id is null
  ) then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'Slate accepts Pennie Google accounts and the Microsoft accounts of invited coordinators only.'
    )
  );
end;
$$;

comment on function public.before_user_created_domain_gate(jsonb) is
  'Supabase Auth before_user_created hook (#3082, #4379): trypennie.com through Google only; an outside address through Microsoft only when an active, unlinked coordinator row holds it; everything else refused before the account exists.';

grant usage on schema public to supabase_auth_admin;
grant execute on function public.before_user_created_domain_gate(jsonb) to supabase_auth_admin;
revoke execute on function public.before_user_created_domain_gate(jsonb) from public, anon, authenticated;

-- 4. -----------------------------------------------------------------------------------
create or replace function auth_logins_by_provider(p_since timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'entries', (select count(*) from auth.audit_log_entries e where e.created_at >= p_since),
    'logins', coalesce((
      select jsonb_agg(jsonb_build_object('provider', l.provider, 'logins', l.logins, 'actors', l.actors) order by l.provider)
      from (
        select coalesce(e.payload->'traits'->>'provider', '') as provider,
               count(*) as logins,
               jsonb_agg(distinct coalesce(e.payload->>'actor_username', '')) as actors
        from auth.audit_log_entries e
        where e.created_at >= p_since
          and e.payload->>'action' = 'login'
        group by 1
      ) l
    ), '[]'::jsonb)
  );
$$;

comment on function auth_logins_by_provider(timestamptz) is
  'Sign ins Supabase Auth recorded since p_since, by provider, and how many audit entries of any kind were written in the window (#4379). Read by the monitor lane, which pages on a sign in by anything but Google or Microsoft.';

revoke execute on function auth_logins_by_provider(timestamptz) from public, anon, authenticated;
