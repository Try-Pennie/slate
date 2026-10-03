-- #3090: a hash chain over audit_log, so an edit made by a role able to switch off
-- the append only triggers is visible afterwards.
--
-- 0089 made audit_log refuse UPDATE, DELETE and TRUNCATE, which stops every caller
-- that goes through the table. It cannot stop a role holding DDL rights: drop or
-- disable the trigger, edit a row, put the trigger back, and nothing records that
-- it happened. This adds the record.
--
-- 1. Every row carries chain_seq (1, 2, 3, ... with no gaps) and chain_hash, the
--    SHA-256 of the previous row's chain_hash plus this row's own content. Editing,
--    removing or reordering a row changes a hash the rows after it were built on.
--
-- 2. The hash is computed by a BEFORE INSERT trigger, inside the database, so no
--    caller can supply it and the code deployed today needs no change: it inserts
--    exactly what it inserts now and the trigger fills both columns.
--
-- 3. Concurrent inserts cannot fork the chain. The trigger takes the single row of
--    audit_log_chain_head FOR UPDATE, so a second insert waits until the first
--    commits or rolls back, then builds on whichever head is current. A rolled back
--    insert rolls its head update back with it, so a failed write leaves no gap and
--    a retried one is simply the next link (L33). The cost is that audit inserts
--    are serialised, which at a few a minute is nothing.
--
-- 4. The content hashed is, in order: the previous hash (64 hex characters), then
--    chain_seq, id, org_id, actor_id, action, target_id, details as jsonb text, and
--    created_at as integer microseconds since the epoch. Each field is written as
--    its byte length, a colon and the value, and a null as a lone tilde, so no two
--    different rows can produce the same text by moving a boundary.
--    src/lib/monitor/audit-chain.ts recomputes exactly this in the monitor lane, and
--    `pnpm verify:audit-chain-sql` proves the two agree on a real Postgres.
--
-- 5. Existing rows are chained here, from a genesis of 64 zeros, oldest first by
--    (created_at, id), inside ONE statement that also installs the trigger, so no
--    insert can land between the backfill and the trigger whether or not the
--    migration runner wraps the file in a transaction. The append only trigger is
--    disabled only for that backfill and re-enabled before the statement ends; if
--    anything in it fails, the whole statement rolls back, the disable included.
--
-- 6. The monitor lane's verifier keeps its place in audit_log_chain_verify, and
--    holds there the last hash it verified. A role that rewrites a row AND
--    recomputes every hash after it still changes that remembered hash, which is
--    what the verifier compares against.
--
-- What this does not do: a role that can rewrite the chain, the head and the
-- verifier's own row together is not detected by anything inside this database.
-- Every other copy of the trail (the Snowflake mirror, the seven day Worker logs)
-- is still outside its reach.
--
-- Every function pins its search_path to public, pg_catalog and calls only
-- pg_catalog built ins (sha256, convert_to, encode, octet_length, extract), never
-- pgcrypto, which a pinned path cannot reach (#1126). The trigger function is
-- SECURITY DEFINER so it can move the head whichever role inserts; EXECUTE is
-- revoked from the API roles on all three. The two new tables are default deny
-- RLS: only the server (secret key) reads them.

alter table audit_log add column if not exists chain_seq bigint;
alter table audit_log add column if not exists chain_hash text;

-- The newest link: one row, moved by every insert under its row lock.
create table if not exists audit_log_chain_head (
  singleton  boolean primary key default true check (singleton),
  seq        bigint not null check (seq >= 0),
  hash       text not null check (hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now()
);

alter table audit_log_chain_head enable row level security;
revoke all on audit_log_chain_head from anon, authenticated;

comment on table audit_log_chain_head is
  'The #3090 audit_log hash chain head: the seq and hash of the newest audit row. One row, moved only by the zz_audit_log_hash_chain trigger. Server only (default deny RLS).';

-- Where the monitor lane's verifier is. pass_* is how far the current walk from
-- the start has got; anchor_* is the furthest row any complete walk has verified,
-- and the hash it had then.
create table if not exists audit_log_chain_verify (
  singleton         boolean primary key default true check (singleton),
  pass_seq          bigint not null check (pass_seq >= 0),
  pass_hash         text not null check (pass_hash ~ '^[0-9a-f]{64}$'),
  anchor_seq        bigint not null check (anchor_seq >= 0),
  anchor_hash       text not null check (anchor_hash ~ '^[0-9a-f]{64}$'),
  last_full_pass_at timestamptz,
  updated_at        timestamptz not null default now()
);

alter table audit_log_chain_verify enable row level security;
revoke all on audit_log_chain_verify from anon, authenticated;

comment on table audit_log_chain_verify is
  'The #3090 audit_log chain verifier position, written by the monitor lane. One row. Server only (default deny RLS).';

-- One field of the hashed text: its byte length, a colon and the value, or a tilde
-- for a null. A length always starts with a digit, so the two cannot be confused.
create or replace function audit_log_chain_field(p text) returns text
  language sql
  immutable
  set search_path = public, pg_catalog
as $$
  select case when p is null then '~' else octet_length(p)::text || ':' || p end
$$;

revoke execute on function audit_log_chain_field(text) from public, anon, authenticated;

-- One link: the hash of the previous hash and this row's content.
create or replace function audit_log_chain_link(
  p_prev       text,
  p_seq        bigint,
  p_id         uuid,
  p_org_id     uuid,
  p_actor_id   uuid,
  p_action     text,
  p_target_id  uuid,
  p_details    jsonb,
  p_created_at timestamptz
) returns text
  language sql
  immutable
  set search_path = public, pg_catalog
as $$
  select encode(sha256(convert_to(
    p_prev
      || audit_log_chain_field(p_seq::text)
      || audit_log_chain_field(p_id::text)
      || audit_log_chain_field(p_org_id::text)
      || audit_log_chain_field(p_actor_id::text)
      || audit_log_chain_field(p_action)
      || audit_log_chain_field(p_target_id::text)
      || audit_log_chain_field(p_details::text)
      || audit_log_chain_field((extract(epoch from p_created_at) * 1000000)::bigint::text),
    'UTF8')), 'hex')
$$;

revoke execute on function audit_log_chain_link(text, bigint, uuid, uuid, uuid, text, uuid, jsonb, timestamptz)
  from public, anon, authenticated;

-- The trigger. Whatever the caller put in chain_seq or chain_hash is overwritten.
create or replace function audit_log_chain_append() returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_catalog
as $$
declare
  v_seq  bigint;
  v_hash text;
begin
  select seq, hash into v_seq, v_hash from audit_log_chain_head where singleton for update;
  if not found then
    raise exception 'audit_log chain head is missing, so this row cannot be chained (#3090)';
  end if;
  new.chain_seq := v_seq + 1;
  new.chain_hash := audit_log_chain_link(
    v_hash, new.chain_seq, new.id, new.org_id, new.actor_id,
    new.action, new.target_id, new.details, new.created_at
  );
  update audit_log_chain_head
     set seq = new.chain_seq, hash = new.chain_hash, updated_at = now()
   where singleton;
  return new;
end;
$$;

revoke execute on function audit_log_chain_append() from public, anon, authenticated;

-- Chain what exists, set the head, install the trigger: one statement, so nothing
-- can be inserted part way through. Idempotent: a re-run finds every row chained,
-- chains nothing, and reinstalls the same trigger over the same head.
do $$
declare
  r      record;
  v_seq  bigint;
  v_hash text;
begin
  -- Blocks every insert until this statement ends.
  lock table audit_log in share row exclusive mode;

  select seq, hash into v_seq, v_hash from audit_log_chain_head where singleton;
  if not found then
    v_seq := 0;
    v_hash := repeat('0', 64);
  end if;

  alter table audit_log disable trigger audit_log_no_update_delete;
  for r in select * from audit_log where chain_seq is null order by created_at, id loop
    v_seq := v_seq + 1;
    v_hash := audit_log_chain_link(
      v_hash, v_seq, r.id, r.org_id, r.actor_id, r.action, r.target_id, r.details, r.created_at
    );
    update audit_log set chain_seq = v_seq, chain_hash = v_hash where id = r.id;
  end loop;
  alter table audit_log enable trigger audit_log_no_update_delete;

  insert into audit_log_chain_head (singleton, seq, hash, updated_at)
  values (true, v_seq, v_hash, now())
  on conflict (singleton) do update set seq = excluded.seq, hash = excluded.hash, updated_at = now();

  -- Named to sort last, because BEFORE triggers fire in name order and the hash
  -- must be taken over the row exactly as it will be stored.
  drop trigger if exists zz_audit_log_hash_chain on audit_log;
  create trigger zz_audit_log_hash_chain
    before insert on audit_log
    for each row execute function audit_log_chain_append();
end;
$$;

-- Every row is chained now, and the trigger chains every row from here on.
alter table audit_log alter column chain_seq set not null;
alter table audit_log alter column chain_hash set not null;
create unique index if not exists audit_log_chain_seq_key on audit_log (chain_seq);
