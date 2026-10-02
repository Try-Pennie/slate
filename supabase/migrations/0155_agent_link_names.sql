-- #3026: a readable name for every advisor's booking link.
--
-- The #2073 link is /book/advisor/<64 hex token>. This gives every user a NAME as
-- well, so the link reads /book/advisor/rdaboub. Old token links keep working:
-- agent_links and its token are untouched, and the app's one resolver
-- (src/lib/agent-link/store.ts) reads a 64 hex value as a token and anything else
-- as a name. The two can never be confused because the CHECK below refuses any
-- name shaped like a token.
--
-- Signed off on the issue: a name can be guessed, and it cannot be replaced
-- without renaming somebody. Abuse is handled by making the advisor not bookable.
--
-- 1. The name is the lowercase email username, set ONCE when the user is created
--    (the trigger below) and backfilled for every user who exists today. It never
--    follows a later email change (Dan, 2026-10-02): there is no update trigger.
--
-- 2. A name is NEVER given to anybody else. Its own table, keyed on the name, so
--    the reservation does not live on the users row and cannot be freed with it:
--      * user_id is ON DELETE SET NULL, never CASCADE, so deleting a user leaves
--        their name reserved and resolving to nobody;
--      * a trigger refuses deleting or truncating a name, renaming one, or moving
--        one to a different user.
--    So when somebody leaves and a later hire has the same username, the links
--    the first person sent can never book the second.
--
-- 3. Uniqueness is the primary key, so the database enforces it, including two
--    users who share a username across the two email domains. A user whose
--    username is already reserved gets the lowest free numbered variant
--    (rdaboub2, then rdaboub3). Safe under concurrent inserts: each candidate is
--    claimed with INSERT ... ON CONFLICT DO NOTHING, which waits on a racing
--    insert of the same name and moves to the next number once it commits.
--
-- 4. The shape. Measured on production 2026-10-02 (read only): 155 users, every
--    email username is lowercase letters and the digits 1 and 2, at most 12
--    characters, none shared. The CHECK allows lowercase letters, digits, dot,
--    underscore and hyphen, beginning and ending with a letter or digit (so no
--    name can be "." or ".." in a URL path), at most 72 characters. Anything else
--    in a username is dropped when the name is derived, and an empty result
--    becomes "advisor".
--
-- Every function pins its search_path to public, pg_catalog and calls only
-- pg_catalog built ins (lower, split_part, regexp_replace, left), so nothing is
-- unreachable at runtime (#1126). None is SECURITY DEFINER; EXECUTE is revoked from
-- the API roles anyway, since nothing outside the database calls them.
-- Default deny RLS like every Slate table: only the server (secret key) reads it.

create table agent_link_names (
  name text primary key
    check (char_length(name) between 1 and 72)
    check (name ~ '^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$')
    -- Never the shape of a #2073 token, so a value in the URL is one or the other.
    check (name !~ '^[0-9a-f]{64}$'),
  -- Null once the user is deleted: the name stays, booking nobody.
  user_id uuid unique references users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table agent_link_names enable row level security;

comment on table agent_link_names is
  'The #3026 readable booking link name: one per user, from the email username, set once at creation and never reused. Server only (default deny RLS). Rows are never deleted or renamed; a deleted user leaves the name reserved with user_id null.';

-- The base a name is derived from: the email username, lowercased, with anything
-- outside the allowed characters dropped and punctuation trimmed from both ends.
create function agent_link_name_base(p_email text) returns text
  language plpgsql
  immutable
  set search_path = public, pg_catalog
as $$
declare
  base text;
begin
  base := regexp_replace(lower(split_part(coalesce(p_email, ''), '@', 1)), '[^a-z0-9._-]', '', 'g');
  base := regexp_replace(left(base, 60), '^[._-]+|[._-]+$', '', 'g');
  if base = '' then
    base := 'advisor';
  end if;
  return base;
end;
$$;

revoke execute on function agent_link_name_base(text) from public, anon, authenticated;

-- Reserve a name for one user and return it. Idempotent: a user who already has a
-- name keeps it. Otherwise the base, then base2, base3 and so on, the first one
-- nobody holds. Bounded, so a fault can never spin forever.
create function reserve_agent_link_name(p_user_id uuid, p_email text) returns text
  language plpgsql
  set search_path = public, pg_catalog
as $$
declare
  base text;
  candidate text;
  got text;
  n integer := 1;
begin
  select name into got from agent_link_names where user_id = p_user_id;
  if got is not null then
    return got;
  end if;

  base := agent_link_name_base(p_email);
  while n <= 10000 loop
    candidate := case when n = 1 then base else base || n::text end;
    if candidate !~ '^[0-9a-f]{64}$' then
      insert into agent_link_names (name, user_id)
      values (candidate, p_user_id)
      on conflict do nothing
      returning name into got;
      if got is not null then
        return got;
      end if;
      -- The conflict may have been on user_id: a racing call reserved this user.
      select name into got from agent_link_names where user_id = p_user_id;
      if got is not null then
        return got;
      end if;
    end if;
    n := n + 1;
  end loop;

  raise exception 'agent link name: no free variant of % after 10000 tries', base;
end;
$$;

revoke execute on function reserve_agent_link_name(uuid, text) from public, anon, authenticated;

create function agent_link_name_for_new_user() returns trigger
  language plpgsql
  set search_path = public, pg_catalog
as $$
begin
  perform reserve_agent_link_name(new.id, new.email);
  return new;
end;
$$;

revoke execute on function agent_link_name_for_new_user() from public, anon, authenticated;

create trigger users_agent_link_name
  after insert on users
  for each row execute function agent_link_name_for_new_user();

-- A name is reserved for good. The ON DELETE SET NULL above is an UPDATE of
-- user_id to null, which is the one change allowed.
create function agent_link_names_keep_reserved() returns trigger
  language plpgsql
  set search_path = public, pg_catalog
as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'agent link names are never released (#3026)';
  end if;
  if new.name is distinct from old.name then
    raise exception 'an agent link name is never renamed (#3026)';
  end if;
  if new.user_id is not null and new.user_id is distinct from old.user_id then
    raise exception 'an agent link name never moves to another user (#3026)';
  end if;
  return new;
end;
$$;

revoke execute on function agent_link_names_keep_reserved() from public, anon, authenticated;

create trigger agent_link_names_keep_reserved_row
  before update or delete on agent_link_names
  for each row execute function agent_link_names_keep_reserved();

create trigger agent_link_names_keep_reserved_truncate
  before truncate on agent_link_names
  for each statement execute function agent_link_names_keep_reserved();

-- Every user who exists today, oldest first, so the rare collision gives the
-- unnumbered name to whoever was here first. Idempotent: a re-run adds nothing.
do $$
declare
  r record;
begin
  for r in select id, email from users order by created_at, id loop
    perform reserve_agent_link_name(r.id, r.email);
  end loop;
end;
$$;
