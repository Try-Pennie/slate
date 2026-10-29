-- #4379: the local stack's sessions are OAuth sessions, as production's always are.
--
-- Slate refuses any session whose verified claims' `amr` is not an OAuth sign in alone
-- (`judgeSessionIdentity`, src/lib/auth/session-identity.ts), because the Email provider
-- is off in production and every real sign in is Google or Microsoft. A local run cannot
-- reach either, so `signIn` (e2e/fixtures.ts) makes its code with a magic link, whose
-- session says `magiclink` or `otp`. This custom access token hook, registered ONLY in
-- e2e/supabase.config.toml, rewrites that one claim to what production's sessions carry,
-- the way e2e/google-identity.ts gives the auth user the Google identity production has.
-- Nothing in the app learns to accept anything less (L719).
--
-- Copied into the throwaway stack's migrations by e2e/run.ts as the last file, and never
-- into supabase/migrations: production has no such hook, and the CHECK at the end names
-- only the real company domain there.
create or replace function public.e2e_oauth_session_claims(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog
as $$
declare
  claims jsonb := event->'claims';
  stamp bigint := coalesce((event->'claims'->'amr'->0->>'timestamp')::bigint, extract(epoch from now())::bigint);
begin
  return jsonb_build_object(
    'claims',
    jsonb_set(claims, '{amr}', jsonb_build_array(jsonb_build_object('method', 'oauth', 'timestamp', stamp)))
  );
end;
$$;

grant execute on function public.e2e_oauth_session_claims(jsonb) to supabase_auth_admin;
revoke execute on function public.e2e_oauth_session_claims(jsonb) from public, anon, authenticated;

-- The local stack's staff sign in on its own reserved Workspace domain (E2E_EMAIL_DOMAIN in
-- e2e/env.ts, which the app's GOOGLE_HOSTED_DOMAIN is set to here), so the rule that an
-- address outside the company domain is a coordinator's (migration 0212) is restated for
-- THAT domain, beside the real one migration 0029's seeded rows are on. The rule itself
-- is unchanged: an active row outside both is only a coordinator.
alter table public.users drop constraint users_outside_email_is_coordinator;
alter table public.users add constraint users_outside_email_is_coordinator
  check (
    role = 'coordinator'
    or deactivated_at is not null
    or coalesce(lower(substring(email from '@([^@]*)$')), '') in ('trypennie.com', 'slate-e2e.test')
  );
