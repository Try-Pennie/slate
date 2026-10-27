-- #4205: the scheduling coordinator role (Phase 7 of milestone 75).
--
-- About five offshore scheduling coordinators book the time a customer names on the
-- phone, from Slate's coordinator booking page, signing in with Pennie Google accounts
-- through the existing sign in. They need their own role: Google sign in creates an
-- `agent` row, and a coordinator must open only that page and never be routed a call.
-- Plan: https://claude.ai/artifact/XbByMLoaMrBufMr6Chmct1
--
-- 1. users_role_check gains 'coordinator' (last defined in 0031). The code's `Role`
--    union and this list are held equal by scripts/test-role-check.ts.
--
-- 2. users_coordinator_never_bookable: a coordinator is never bookable. The round robin
--    pool reads `bookable`, so this is what keeps a coordinator out of it whichever
--    writer forgot, and writeRoutableState (the only writer of bookable) fails loudly on
--    an attempt rather than arming one. The same shape as 0207's
--    users_placeholder_never_bookable.
--
-- Additive only: a widened CHECK every existing row still satisfies (no row holds the new
-- role yet), so the deployed code keeps working from the apply to the deploy. Replacing
-- the CHECK re-validates the users table, which is roster sized.

alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check
  check (role in ('super_admin', 'admin', 'team_lead', 'manager', 'agent', 'coordinator'));

alter table users
  add constraint users_coordinator_never_bookable check (role <> 'coordinator' or bookable = false);

comment on column users.role is
  'The person''s role (#4205): agent < manager < team_lead < admin < super_admin, and coordinator, a scheduling coordinator who opens only the coordinator booking page and is never bookable (users_coordinator_never_bookable).';
