-- #2073: a booking link an agent sends for their OWN later calls with a lead.
--
-- Every public path into the booker routes through a pool. Agents book those calls
-- today through their personal cal.com links, and cutover removes those, so this
-- gives every agent a stable, unguessable link that books that one agent: no
-- bucket resolution, no round robin, no tier ladder. Two schema changes.
--
-- 1. agent_links: one token per user.
--
--    Keyed on a RANDOM token, never the email: an email is guessable and a link
--    keyed on it would leak the roster, and a token can be replaced when it
--    leaks. 64 lowercase hex characters is 256 bits. The database mints the first
--    one (the backfill below and the trigger for every user created afterwards);
--    an admin replaces it from the agent's page, which writes a new one minted by
--    the app (src/lib/agent-link/link.ts, newAgentLinkToken) in the same shape, so
--    the CHECK holds both producers to one format.
--
--    The database mint hashes two gen_random_uuid() values with sha256. Both are
--    pg_catalog built ins (PG 13 and PG 11), so the trigger function's pinned
--    search_path reaches them (#1126), and gen_random_uuid draws from the strong
--    random source, so the 244 random bits in the input survive the hash.
--
--    Its own table rather than a column on users, because users is read with
--    select("*") in many places, several of which hand the row to a client
--    component. A bearer secret on that row would travel wherever the row does.
--    Default deny RLS like every Slate table: only the server (secret key) reads it.
--
-- 2. bookings.kind: whether a booking was ROUTED or booked through a named link.
--
--    Every monitor, rate and analytics reader reasons about routed bookings (the
--    low booking volume alarm, the per page volume, the catch all rate, the bucket
--    share ranking). A named link booking still lands in a bucket, because bookings.bucket_id
--    is NOT NULL and the webhook needs an event type, so without a recorded kind
--    it would dilute every one of them. Existing rows are routed, which is what
--    the default says; a constant default is a catalog change on PG 11 and later,
--    so no row is rewritten, updated_at does not move and the Snowflake export
--    cursor needs no rewind. Not mirrored to Snowflake in this change: the export
--    writes every column it names on every MERGE, so the warehouse ALTER has to
--    run first.

create table agent_links (
  user_id uuid primary key references users(id) on delete cascade,
  token text not null unique check (token ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  -- When the current token replaced an earlier one, and who replaced it. Null
  -- while the token is still the first one minted.
  rotated_at timestamptz,
  rotated_by uuid references users(id) on delete set null
);

alter table agent_links enable row level security;

comment on table agent_links is
  'The #2073 named booking link: one unguessable token per user that books that user directly. Server only (default deny RLS). Replaced by an admin, which stops the old link working.';

create function agent_link_for_new_user() returns trigger
  language plpgsql
  set search_path = public, pg_catalog
as $$
begin
  insert into agent_links (user_id, token)
  values (
    new.id,
    encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex')
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke execute on function agent_link_for_new_user() from public, anon, authenticated;

create trigger users_agent_link
  after insert on users
  for each row execute function agent_link_for_new_user();

-- Every user who exists today gets a link. Idempotent, so a re-run adds nothing.
insert into agent_links (user_id, token)
select
  id,
  encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex')
from users
on conflict (user_id) do nothing;

alter table bookings
  add column kind text not null default 'routed';

alter table bookings
  add constraint bookings_kind_check check (kind in ('routed', 'agent_link'));

comment on column bookings.kind is
  'The #2073 booking kind: routed (through a bucket pool, every public booker path and the API) or agent_link (booked through an agent''s own named link, which does not route). Every reader that reasons about ROUTED bookings filters on this.';
