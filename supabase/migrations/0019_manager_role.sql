-- Add the "manager" tier between agent and admin (agent < manager < admin).
-- Managers can edit any agent's settings/hours; admins also own org/app config
-- and role assignment. Default stays 'agent'; existing rows are unchanged.
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check
  check (role in ('admin', 'manager', 'agent'));
