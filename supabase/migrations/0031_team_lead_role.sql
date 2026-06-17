-- Add the "team_lead" tier between manager and admin
-- (agent < manager < team_lead < admin < super_admin). Team leads have every
-- manager permission PLUS the ability to approve/decline time off for ANY agent
-- (not just their own reports) — but no other admin powers. Default stays
-- 'agent'; existing rows are unchanged.
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check
  check (role in ('super_admin', 'admin', 'team_lead', 'manager', 'agent'));
