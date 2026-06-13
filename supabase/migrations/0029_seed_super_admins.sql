-- Pre-create the super admins who haven't signed into Slate yet, so the role is
-- already assigned the first time they log in. provisionUser() links an existing
-- row by email and updates only auth/avatar fields, so the seeded role sticks.
-- Idempotent: re-promotes any matching row that already exists.
insert into users (org_id, email, name, role, bookable, attributes)
select org.id, e.email, null, 'super_admin', false, '{}'::jsonb
from (select id from organizations order by created_at asc limit 1) as org
cross join (values
  ('geoff@trypennie.com'),
  ('sam@trypennie.com'),
  ('bnelms@trypennie.com'),
  ('nmogil@trypennie.com')
) as e(email)
on conflict (email) do update set role = 'super_admin';
