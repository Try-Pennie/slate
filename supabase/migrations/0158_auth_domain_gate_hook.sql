-- #3082: refuse an account outside trypennie.com BEFORE Supabase Auth creates it.
--
-- Until now the domain gate lived only in the app: the OAuth callback
-- (src/app/api/auth/callback/route.ts) checks the email after the code exchange,
-- which means GoTrue has already created the auth.users row and issued a signed in
-- JWT to the outsider by the time Slate refuses them. The data stayed behind RLS
-- default deny, but an outside account existed, and with the Email provider on,
-- /signup and /recover were reachable with the public key.
--
-- This is Supabase's before_user_created auth hook as a Postgres function. GoTrue
-- calls it with the user it is about to insert, for EVERY way an account can be
-- created (Google, email, phone, anonymous, the admin API), and an `error` object
-- in the reply refuses the creation: no row, no session. It is registered
-- separately from this migration: supabase/config.toml for the local stack, and
-- the dashboard (Authentication, Hooks) for the hosted project, because a hook's
-- registration is Auth configuration, not schema.
--
-- The rule is the app's own (src/lib/auth/domain.ts, isAllowedEmail): the part
-- after the LAST @ must equal trypennie.com exactly, case insensitive. No
-- subdomain and no suffix, so foo@evil.trypennie.com and foo@trypennie.com.evil.com
-- are both refused. A user with no email at all (phone, anonymous) is refused too:
-- no Slate account is anything but a Workspace Google account. Measured on
-- production 2026-10-03: all 86 auth.users have a google identity on
-- trypennie.com and none use email, so nothing that exists today is shaped like a
-- refusal. The hook runs only at creation, so existing accounts are untouched.
--
-- The domain is written here rather than read from a table: it is the same fixed
-- value as GOOGLE_HOSTED_DOMAIN in wrangler.jsonc, and
-- scripts/test-auth-domain-hook.ts fails the build if the two ever differ.
--
-- Fails closed: if this function errors for any reason, GoTrue refuses the
-- creation rather than skipping the hook.
--
-- Not SECURITY DEFINER (it reads no table), and the search_path is pinned to
-- pg_catalog, whose built ins (lower, substring, coalesce, jsonb_build_object) are
-- all it calls (#1126). EXECUTE goes to supabase_auth_admin, the role GoTrue runs
-- the hook as, and is taken back from public, anon and authenticated so it is
-- never callable over PostgREST. supabase_auth_admin also needs USAGE on public to
-- reach the function at all; usage alone grants it no table.

create or replace function public.before_user_created_domain_gate(event jsonb)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  email_domain text := lower(substring(coalesce(event->'user'->>'email', '') from '@([^@]*)$'));
begin
  if email_domain is not null and email_domain = 'trypennie.com' then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'Slate accepts trypennie.com Google accounts only.'
    )
  );
end;
$$;

comment on function public.before_user_created_domain_gate(jsonb) is
  'Supabase Auth before_user_created hook (#3082): refuses any account whose email is not on trypennie.com before it is created.';

grant usage on schema public to supabase_auth_admin;
grant execute on function public.before_user_created_domain_gate(jsonb) to supabase_auth_admin;
revoke execute on function public.before_user_created_domain_gate(jsonb) from public, anon, authenticated;
