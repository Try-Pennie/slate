-- #1648: make a SECOND organization impossible by a key, not by the ordering of a
-- read and an insert.
--
-- ensureDefaultOrg runs on every login as read then insert, and swallowed its read
-- error, so a transient failure created a second organizations row. Two concurrent
-- first logins did the same thing without any error at all: both correctly read an
-- empty table, and both inserted.
--
-- Slate is single org on purpose, and resolveBucketByCode looks a bucket up
-- GLOBALLY by code, so a second organization mis scopes reads rather than merely
-- adding a stray row: every bucket code in the second org collides with the first.
--
-- The key chosen: at most one organization may be flagged as the default. That is
-- narrower than banning a second organization outright (a second, non default org
-- stays possible if Slate ever needs one) and it is exactly the invariant
-- ensureDefaultOrg depends on, so the read and the write are now keyed on the same
-- column instead of on "the oldest row" and "whatever we just inserted".
--
-- Deliberately NOT an ON CONFLICT target: a PARTIAL unique index cannot back an
-- upsert (Postgres 42P10). The caller inserts plainly and treats SQLSTATE 23505 as
-- "a concurrent login won", re-reading the winner's row.
--
-- Measured against production on 2026-08-31 before writing this: 1 organizations
-- row, so the backfill marks that row and the index applies with no violation.

alter table organizations
  add column if not exists is_default boolean not null default false;

comment on column organizations.is_default is
  'The single org ensureDefaultOrg resolves a login to. At most one row may have this true (organizations_single_default_idx).';

-- The oldest row is the one ensureDefaultOrg has been returning, so it is the
-- default. Written as a subquery over created_at (with id as the tie break) rather
-- than assuming one row, so it stays correct if this ever runs on a database that
-- already picked up a duplicate.
update organizations
set is_default = true
where id = (select id from organizations order by created_at asc, id asc limit 1);

create unique index if not exists organizations_single_default_idx
  on organizations (is_default)
  where is_default;
