-- Add the "super_admin" tier above admin (agent < manager < admin < super_admin).
-- Super admins can edit the org-wide default working hours (regular admins can't)
-- and are the only role that can grant or revoke super_admin. Default stays
-- 'agent'; existing rows are unchanged except the seeded staff below.
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check
  check (role in ('super_admin', 'admin', 'manager', 'agent'));

-- Seed the initial super admins (Pennie internal staff). Idempotent: only
-- promotes matching rows that already exist; logging in later keeps the role.
update users set role = 'super_admin'
where lower(email) in (
  'geoff@trypennie.com',
  'sam@trypennie.com',
  'dwright@trypennie.com',
  'bnelms@trypennie.com',
  'nmogil@trypennie.com'
);
