-- Decouple agents from logins: a Slate user no longer requires an auth.users
-- row (Salesforce-synced agents never log in). Admins who do log in are linked
-- via a nullable auth_user_id.

alter table users drop constraint users_id_fkey;       -- was: id -> auth.users(id)
alter table users alter column id set default gen_random_uuid();
alter table users add column auth_user_id uuid references auth.users(id) on delete set null;

-- Existing rows were auth-backed; link them.
update users set auth_user_id = id where auth_user_id is null;

create unique index users_auth_user_id_key
  on users(auth_user_id) where auth_user_id is not null;

-- RLS self-select now keys on auth_user_id.
drop policy "self can read own user row" on users;
create policy "self can read own user row" on users
  for select using (auth_user_id = auth.uid());
