-- #3247 (phase 1 of #3244): rerouting a booking into a corrected bucket.
--
-- An admin corrects a booking's bucket and Slate re-routes it at the SAME time
-- through the booker's own routing. When that finds a new advisor, the advisor is
-- HELD at that time for five minutes while the admin confirms, so no lead, admin or
-- coverage sweep can take them meanwhile. This migration is the schema half:
--
--   1. reroute_holds, its own table (never a bookings row, so no booking reader ever
--      sees a hold);
--   2. a trigger on bookings that refuses an active booking landing on a held
--      advisor's window, raised as 23P01 (exclusion_violation) with constraint name
--      reroute_hold, which the booker's isSlotClash already reads as a lost race.
--      It is the BACKSTOP: phase 2 makes the booker skip held advisors before it
--      sends any invite;
--   3. place_reroute_hold and claim_reroute_hold;
--   4. a bucket aware reassign_booking_swap that moves (or keeps) the agent, writes
--      the corrected bucket and trace, consumes the hold and records a routing
--      decision, all in one transaction;
--   5. booking_events and routing_decisions accept the new values.
--
-- Everything here is ADDITIVE for the deployed code (docs/migrations-runbook.md,
-- "Deployed code must keep working"): the seven argument reassign_booking_swap is
-- kept, as a thin wrapper over the new one, so the code live between apply and
-- deploy calls the body it always had. The new overload takes NO defaults on
-- purpose: a defaulted parameter would make a seven argument call match both
-- signatures and fail as "function is not unique".

-- ---------------------------------------------------------------------------
-- 1. The hold
-- ---------------------------------------------------------------------------
create table reroute_holds (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id) on delete cascade,
  -- One hold per booking. Placing again REPLACES it, a consumed one included, so a
  -- later correction of the same booking is never blocked by an old result.
  booking_id          uuid not null unique references bookings(id) on delete cascade,
  agent_user_id       uuid not null references users(id) on delete cascade,
  -- The BUFFERED window (the event type's buffers around the call), which is what
  -- the held call occupies on the advisor's diary (red team 3).
  buffered_starts_at  timestamptz not null,
  buffered_ends_at    timestamptz not null,
  -- The call itself, captured at placement. The claim refuses once the booking no
  -- longer has this start or this reschedule_seq (red team 8); the raw end is what a
  -- neighbouring call's buffer is compared against.
  booking_starts_at   timestamptz not null,
  booking_ends_at     timestamptz not null,
  reschedule_seq      int not null,
  requested_bucket_id uuid not null references buckets(id) on delete cascade,
  target_bucket_id    uuid not null references buckets(id) on delete cascade,
  rungs_dropped       int not null default 0 check (rungs_dropped >= 0),
  created_by          uuid references users(id) on delete set null,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  -- The confirm lease: stamped by claim_reroute_hold, which also pushes expires_at
  -- out so a confirm begun at 4:58 cannot expire during its Google call (audit 2).
  claimed_at          timestamptz,
  -- Kept, never deleted, on success: a second confirm reads the first result rather
  -- than "expired" (audit 3).
  consumed_at         timestamptz,
  result              jsonb,
  check (buffered_ends_at > buffered_starts_at),
  check (booking_ends_at > booking_starts_at)
);

-- The trigger and placement ask "is this agent held near this window?".
create index reroute_holds_agent_live_idx on reroute_holds (agent_user_id, buffered_starts_at)
  where consumed_at is null;

-- Server only, through the secret key client; default deny like reassign_intents.
alter table reroute_holds enable row level security;

-- ---------------------------------------------------------------------------
-- The one clash rule, shared by the trigger and placement
-- ---------------------------------------------------------------------------
-- Two calls clash when EITHER call's buffered window overlaps the other's raw
-- window: each call keeps its own buffer clear of the other call. That is the slot
-- judge's rule (it pads the offered call against raw busy time), applied from both
-- sides, rather than buffered against buffered, which would demand twice the gap
-- the booker ever offers. Half open, like bookings_active_no_overlap.
create or replace function reroute_window_clash(
  a_starts timestamptz, a_ends timestamptz, a_buf_starts timestamptz, a_buf_ends timestamptz,
  b_starts timestamptz, b_ends timestamptz, b_buf_starts timestamptz, b_buf_ends timestamptz
) returns boolean
language sql
immutable
set search_path = public
as $$
  select tstzrange(a_buf_starts, a_buf_ends, '[)') && tstzrange(b_starts, b_ends, '[)')
      or tstzrange(a_starts, a_ends, '[)') && tstzrange(b_buf_starts, b_buf_ends, '[)');
$$;

-- ---------------------------------------------------------------------------
-- 2. The backstop trigger on bookings
-- ---------------------------------------------------------------------------
create or replace function bookings_refuse_held_agent()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_before int;
  v_after  int;
  v_until  timestamptz;
begin
  if new.assigned_user_id is null or new.status not in ('confirmed', 'rescheduled') then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.assigned_user_id is not distinct from old.assigned_user_id
     and new.starts_at = old.starts_at
     and new.ends_at = old.ends_at
     and new.status = old.status then
    return new;
  end if;

  -- The same lock place_reroute_hold takes, so a booking and a hold for one agent
  -- can never both commit having each not seen the other.
  perform pg_advisory_xact_lock(hashtext('reroute_hold'), hashtext(new.assigned_user_id::text));

  select et.buffer_before_min, et.buffer_after_min into v_before, v_after
    from event_types et where et.id = new.event_type_id;

  select h.expires_at into v_until
    from reroute_holds h
    join bookings hb on hb.id = h.booking_id
   where h.agent_user_id = new.assigned_user_id
     and h.booking_id <> new.id
     and h.consumed_at is null
     and h.expires_at > now()
     -- A hold whose booking is no longer active holds nobody (red team 8).
     and hb.status in ('confirmed', 'rescheduled')
     and reroute_window_clash(
           new.starts_at, new.ends_at,
           new.starts_at - make_interval(mins => coalesce(v_before, 0)),
           new.ends_at + make_interval(mins => coalesce(v_after, 0)),
           h.booking_starts_at, h.booking_ends_at, h.buffered_starts_at, h.buffered_ends_at)
   order by h.expires_at desc
   limit 1;

  if found then
    raise exception 'agent % is held for a bucket correction until %', new.assigned_user_id, v_until
      using errcode = 'exclusion_violation',
            constraint = 'reroute_hold',
            detail = 'held_until=' || to_char(v_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            hint = 'A reroute hold is a lost race for this agent and window; route to another agent.';
  end if;
  return new;
end
$$;

revoke execute on function bookings_refuse_held_agent() from public, anon, authenticated;

create trigger bookings_refuse_held_agent
  before insert or update of assigned_user_id, starts_at, ends_at, status on bookings
  for each row execute function bookings_refuse_held_agent();

-- Every cancel path, present and future, drops the booking's hold: a cancelled or
-- completed booking has nothing left to correct.
create or replace function bookings_release_reroute_hold()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  delete from reroute_holds where booking_id = new.id;
  return null;
end
$$;

revoke execute on function bookings_release_reroute_hold() from public, anon, authenticated;

create trigger bookings_release_reroute_hold
  after update of status on bookings
  for each row
  when (new.status in ('cancelled', 'completed') and old.status is distinct from new.status)
  execute function bookings_release_reroute_hold();

-- ---------------------------------------------------------------------------
-- 3a. place_reroute_hold
-- ---------------------------------------------------------------------------
-- Holds p_agent_user_id at the booking's own buffered window for five minutes. Each
-- refusal is its own word (L11), returned rather than raised so the route can map
-- it to its own message. Checks org itself rather than trusting the route (audit 11).
create or replace function place_reroute_hold(
  p_org_id              uuid,
  p_booking_id          uuid,
  p_agent_user_id       uuid,
  p_requested_bucket_id uuid,
  p_target_bucket_id    uuid,
  p_rungs_dropped       int,
  p_created_by          uuid
) returns table (hold_id uuid, expires_at timestamptz, refused text)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_bk        bookings%rowtype;
  v_before    int;
  v_after     int;
  v_buf_start timestamptz;
  v_buf_end   timestamptz;
  v_target_et uuid;
  v_target_org uuid;
  v_req_org   uuid;
  v_agent_org uuid;
  v_existing  reroute_holds%rowtype;
  v_id        uuid;
  v_expires   timestamptz;
begin
  -- Taken FIRST, before any read the decision rests on.
  perform pg_advisory_xact_lock(hashtext('reroute_hold'), hashtext(p_agent_user_id::text));

  select * into v_bk from bookings b where b.id = p_booking_id;
  if not found then
    return query select null::uuid, null::timestamptz, 'booking_not_found'::text; return;
  end if;
  if v_bk.org_id <> p_org_id then
    return query select null::uuid, null::timestamptz, 'org_mismatch'::text; return;
  end if;
  if v_bk.status not in ('confirmed', 'rescheduled') then
    return query select null::uuid, null::timestamptz, 'booking_inactive'::text; return;
  end if;
  if v_bk.kind = 'agent_link' then
    return query select null::uuid, null::timestamptz, 'agent_link'::text; return;
  end if;
  if v_bk.starts_at <= now() then
    return query select null::uuid, null::timestamptz, 'booking_started'::text; return;
  end if;
  if v_bk.assigned_user_id = p_agent_user_id then
    return query select null::uuid, null::timestamptz, 'agent_is_current'::text; return;
  end if;

  select u.org_id into v_agent_org from users u where u.id = p_agent_user_id;
  if v_agent_org is distinct from p_org_id then
    return query select null::uuid, null::timestamptz, 'agent_not_in_org'::text; return;
  end if;

  select bu.event_type_id, bu.org_id into v_target_et, v_target_org from buckets bu where bu.id = p_target_bucket_id;
  select bu.org_id into v_req_org from buckets bu where bu.id = p_requested_bucket_id;
  if v_target_org is distinct from p_org_id or v_req_org is distinct from p_org_id then
    return query select null::uuid, null::timestamptz, 'bucket_not_in_org'::text; return;
  end if;
  if v_target_et <> v_bk.event_type_id then
    return query select null::uuid, null::timestamptz, 'event_type_mismatch'::text; return;
  end if;

  select * into v_existing from reroute_holds h where h.booking_id = p_booking_id for update;
  if found and v_existing.claimed_at is not null and v_existing.consumed_at is null
     and v_existing.expires_at > now() then
    return query select null::uuid, null::timestamptz, 'confirm_in_progress'::text; return;
  end if;

  select et.buffer_before_min, et.buffer_after_min into v_before, v_after
    from event_types et where et.id = v_bk.event_type_id;
  v_buf_start := v_bk.starts_at - make_interval(mins => coalesce(v_before, 0));
  v_buf_end   := v_bk.ends_at + make_interval(mins => coalesce(v_after, 0));

  -- An active booking of the agent's own, judged by the clash rule with ITS buffers.
  if exists (
    select 1
      from bookings ob
      join event_types oet on oet.id = ob.event_type_id
     where ob.assigned_user_id = p_agent_user_id
       and ob.id <> p_booking_id
       and ob.status in ('confirmed', 'rescheduled')
       and reroute_window_clash(
             v_bk.starts_at, v_bk.ends_at, v_buf_start, v_buf_end,
             ob.starts_at, ob.ends_at,
             ob.starts_at - make_interval(mins => oet.buffer_before_min),
             ob.ends_at + make_interval(mins => oet.buffer_after_min))
  ) then
    return query select null::uuid, null::timestamptz, 'agent_busy'::text; return;
  end if;

  -- Another booking's live hold on the same agent.
  if exists (
    select 1
      from reroute_holds oh
      join bookings ohb on ohb.id = oh.booking_id
     where oh.agent_user_id = p_agent_user_id
       and oh.booking_id <> p_booking_id
       and oh.consumed_at is null
       and oh.expires_at > now()
       and ohb.status in ('confirmed', 'rescheduled')
       and reroute_window_clash(
             v_bk.starts_at, v_bk.ends_at, v_buf_start, v_buf_end,
             oh.booking_starts_at, oh.booking_ends_at, oh.buffered_starts_at, oh.buffered_ends_at)
  ) then
    return query select null::uuid, null::timestamptz, 'agent_held'::text; return;
  end if;

  delete from reroute_holds h where h.booking_id = p_booking_id;

  v_expires := now() + interval '5 minutes';
  insert into reroute_holds (
    org_id, booking_id, agent_user_id, buffered_starts_at, buffered_ends_at,
    booking_starts_at, booking_ends_at, reschedule_seq, requested_bucket_id,
    target_bucket_id, rungs_dropped, created_by, expires_at
  ) values (
    p_org_id, p_booking_id, p_agent_user_id, v_buf_start, v_buf_end,
    v_bk.starts_at, v_bk.ends_at, v_bk.reschedule_seq, p_requested_bucket_id,
    p_target_bucket_id, coalesce(p_rungs_dropped, 0), p_created_by, v_expires
  ) returning id into v_id;

  return query select v_id, v_expires, null::text;
end
$$;

revoke execute on function place_reroute_hold(uuid, uuid, uuid, uuid, uuid, int, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3b. claim_reroute_hold
-- ---------------------------------------------------------------------------
-- The first step of a confirm. Refuses a hold that is not this booking's (or this
-- org's), expired, already consumed (returning the stored result, audit 3), or whose
-- booking has moved since placement. Otherwise stamps claimed_at and pushes the
-- expiry out to a two minute confirm lease.
create or replace function claim_reroute_hold(
  p_org_id     uuid,
  p_booking_id uuid,
  p_hold_id    uuid
) returns table (
  hold_id          uuid,
  agent_user_id    uuid,
  target_bucket_id uuid,
  expires_at       timestamptz,
  refused          text,
  result           jsonb
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_hold reroute_holds%rowtype;
  v_bk   bookings%rowtype;
  v_exp  timestamptz;
begin
  select * into v_hold from reroute_holds h where h.id = p_hold_id for update;
  if not found or v_hold.booking_id <> p_booking_id or v_hold.org_id <> p_org_id then
    return query select null::uuid, null::uuid, null::uuid, null::timestamptz, 'hold_not_found'::text, null::jsonb;
    return;
  end if;
  if v_hold.consumed_at is not null then
    return query select v_hold.id, v_hold.agent_user_id, v_hold.target_bucket_id, v_hold.expires_at,
      'hold_consumed'::text, v_hold.result;
    return;
  end if;
  if v_hold.expires_at <= now() then
    return query select v_hold.id, v_hold.agent_user_id, v_hold.target_bucket_id, v_hold.expires_at,
      'hold_expired'::text, null::jsonb;
    return;
  end if;

  select * into v_bk from bookings b where b.id = p_booking_id;
  if not found or v_bk.status not in ('confirmed', 'rescheduled') then
    return query select v_hold.id, v_hold.agent_user_id, v_hold.target_bucket_id, v_hold.expires_at,
      'booking_inactive'::text, null::jsonb;
    return;
  end if;
  if v_bk.starts_at <> v_hold.booking_starts_at or v_bk.reschedule_seq <> v_hold.reschedule_seq then
    return query select v_hold.id, v_hold.agent_user_id, v_hold.target_bucket_id, v_hold.expires_at,
      'booking_moved'::text, null::jsonb;
    return;
  end if;

  v_exp := greatest(v_hold.expires_at, now() + interval '2 minutes');
  update reroute_holds h set claimed_at = now(), expires_at = v_exp where h.id = v_hold.id;

  return query select v_hold.id, v_hold.agent_user_id, v_hold.target_bucket_id, v_exp, null::text, null::jsonb;
end
$$;

revoke execute on function claim_reroute_hold(uuid, uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The bucket aware swap
-- ---------------------------------------------------------------------------
-- The seven argument form the deployed code calls, now a thin wrapper over the
-- bucket aware body BELOW with no bucket, so there is one reassign body rather than
-- two. Same signature and return shape as 0133, replaced in place. It is defined
-- first and the body last only so the newest definition in the tree is the body
-- (PL/pgSQL resolves the call when it runs, not when it is created, so the order is
-- otherwise immaterial within this one transaction).
create or replace function reassign_booking_swap(
  p_booking_id     uuid,
  p_user_id        uuid,
  p_agent_name     text,
  p_agent_email    text,
  p_gcal_event_id  text,
  p_routing_trace  jsonb,
  p_gcal_client_id text
) returns table (prev_gcal_event_id text, prev_agent_email text, updated boolean)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select s.prev_gcal_event_id, s.prev_agent_email, s.updated
      from reassign_booking_swap(
        p_booking_id          => p_booking_id,
        p_user_id             => p_user_id,
        p_agent_name          => p_agent_name,
        p_agent_email         => p_agent_email,
        p_gcal_event_id       => p_gcal_event_id,
        p_routing_trace       => p_routing_trace,
        p_gcal_client_id      => p_gcal_client_id,
        p_bucket_id           => null::uuid,
        p_requested_bucket_id => null::uuid,
        p_requested_tier      => null::text,
        p_booked_tier         => null::text,
        p_rungs_dropped       => null::int,
        p_hold_id             => null::uuid,
        p_result              => null::jsonb
      ) s;
end
$$;

revoke execute on function reassign_booking_swap(uuid, uuid, text, text, text, jsonb, text)
  from public, anon, authenticated;

-- With p_bucket_id NULL this is exactly the 0133 reassign (it is what the seven
-- argument wrapper above calls). With a bucket it is a reroute:
--   * a MOVE (p_hold_id given) needs a claimed, live hold for this booking, this
--     agent and this bucket, and consumes it here;
--   * a KEEP (no hold, p_user_id the current agent) changes only the bucket and the
--     trace. A new agent with no hold is refused: only a hold makes a move.
-- Either way it writes bucket_id, rewrites the trace's top level bucket_code,
-- bucket_id, requested_tier, booked_tier, tier_fallback and rungs_dropped, appends
-- the PRIOR values to routing_trace.reroutes (red team 6), and records a
-- routing_decisions row under outcome 'rerouted' (audit 4).
--
-- allow_double_book: 0017 sets it TRUE on a reassign because an owner reassign
-- deliberately double books an advisor onto a lead they own. A reroute move keeps
-- it FALSE: its target was live verified free, so the booking stays inside the
-- overlap guards (audit 9). A keep leaves it as it was.
create or replace function reassign_booking_swap(
  p_booking_id          uuid,
  p_user_id             uuid,
  p_agent_name          text,
  p_agent_email         text,
  p_gcal_event_id       text,
  p_routing_trace       jsonb,
  p_gcal_client_id      text,
  p_bucket_id           uuid,
  p_requested_bucket_id uuid,
  p_requested_tier      text,
  p_booked_tier         text,
  p_rungs_dropped       int,
  p_hold_id             uuid,
  p_result              jsonb
) returns table (prev_gcal_event_id text, prev_agent_email text, updated boolean, refused text)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_bk          bookings%rowtype;
  v_base        jsonb;
  v_existing    jsonb;
  v_reroutes    jsonb;
  v_bucket      buckets%rowtype;
  v_req_code    text;
  v_hold        reroute_holds%rowtype;
  v_keep        boolean;
  v_rungs       int;
begin
  -- Row lock so concurrent swaps of THIS booking serialize on the current trace.
  select * into v_bk from bookings b where b.id = p_booking_id for update;

  if not found or v_bk.status in ('cancelled', 'completed') then
    return query select null::text, null::text, false, 'booking_inactive'::text;
    return;
  end if;

  v_base := coalesce(v_bk.routing_trace, p_routing_trace, '{}'::jsonb);

  -- ------------------------------------------------------------ plain reassign
  if p_bucket_id is null then
    v_existing := case
      when jsonb_typeof(v_base -> 'reassignments') = 'array' then v_base -> 'reassignments'
      else '[]'::jsonb
    end;
    -- No status write (#2617).
    update bookings b set
      assigned_user_id  = p_user_id,
      agent_name        = p_agent_name,
      agent_email       = p_agent_email,
      gcal_event_id     = p_gcal_event_id,
      allow_double_book = true,
      routing_trace     = jsonb_set(
        v_base, '{reassignments}',
        v_existing || jsonb_build_array(
          jsonb_build_object('from', v_bk.assigned_user_id::text, 'to', p_user_id::text, 'at', now())),
        true)
    where b.id = p_booking_id;

    update reassign_intents ri set
      prev_agent_email   = v_bk.agent_email,
      prev_gcal_event_id = v_bk.gcal_event_id,
      swapped_at         = now()
    where ri.booking_id = p_booking_id
      and ri.gcal_client_id = p_gcal_client_id;

    return query select v_bk.gcal_event_id, v_bk.agent_email, true, null::text;
    return;
  end if;

  -- ------------------------------------------------------------ reroute
  if v_bk.kind = 'agent_link' then
    return query select null::text, null::text, false, 'agent_link'::text;
    return;
  end if;

  select * into v_bucket from buckets bu where bu.id = p_bucket_id;
  if not found or v_bucket.org_id <> v_bk.org_id or v_bucket.event_type_id <> v_bk.event_type_id then
    return query select null::text, null::text, false, 'bucket_mismatch'::text;
    return;
  end if;
  select bu.code into v_req_code from buckets bu
   where bu.id = coalesce(p_requested_bucket_id, p_bucket_id) and bu.org_id = v_bk.org_id;
  if v_req_code is null then
    return query select null::text, null::text, false, 'bucket_mismatch'::text;
    return;
  end if;

  -- A hold makes this a MOVE whoever the booking now names, so a repeated confirm of
  -- a consumed hold (whose booking already names the held agent) is refused as
  -- consumed rather than read as a keep.
  v_keep := p_hold_id is null;
  v_rungs := coalesce(p_rungs_dropped, 0);

  if v_keep and p_user_id is distinct from v_bk.assigned_user_id then
    return query select null::text, null::text, false, 'hold_not_found'::text;
    return;
  end if;

  if not v_keep then
    select * into v_hold from reroute_holds h where h.id = p_hold_id for update;
    if not found or v_hold.booking_id <> p_booking_id then
      return query select null::text, null::text, false, 'hold_not_found'::text;
      return;
    end if;
    if v_hold.consumed_at is not null then
      return query select null::text, null::text, false, 'hold_consumed'::text;
      return;
    end if;
    if v_hold.expires_at <= now() then
      return query select null::text, null::text, false, 'hold_expired'::text;
      return;
    end if;
    if v_hold.claimed_at is null then
      return query select null::text, null::text, false, 'hold_not_claimed'::text;
      return;
    end if;
    if v_hold.agent_user_id <> p_user_id or v_hold.target_bucket_id <> p_bucket_id then
      return query select null::text, null::text, false, 'hold_mismatch'::text;
      return;
    end if;
    if v_bk.starts_at <> v_hold.booking_starts_at or v_bk.reschedule_seq <> v_hold.reschedule_seq then
      return query select null::text, null::text, false, 'booking_moved'::text;
      return;
    end if;
  end if;

  v_reroutes := case
    when jsonb_typeof(v_base -> 'reroutes') = 'array' then v_base -> 'reroutes'
    else '[]'::jsonb
  end || jsonb_build_array(jsonb_build_object(
    'bucket_code',    v_base -> 'bucket_code',
    'bucket_id',      v_base -> 'bucket_id',
    'requested_tier', v_base -> 'requested_tier',
    'booked_tier',    v_base -> 'booked_tier',
    'tier_fallback',  v_base -> 'tier_fallback',
    'rungs_dropped',  v_base -> 'rungs_dropped',
    'to_bucket_code', v_bucket.code,
    'requested_code', v_req_code,
    'kept',           v_keep,
    'at',             now()
  ));

  v_base := v_base || jsonb_build_object(
    'bucket_code',    v_bucket.code,
    'bucket_id',      v_bucket.id,
    'requested_tier', p_requested_tier,
    'booked_tier',    p_booked_tier,
    'tier_fallback',  v_rungs > 0,
    'rungs_dropped',  v_rungs,
    'reroutes',       v_reroutes
  );

  if v_keep then
    update bookings b set bucket_id = v_bucket.id, routing_trace = v_base where b.id = p_booking_id;
    -- A keep supersedes any hold this booking still had.
    delete from reroute_holds h where h.booking_id = p_booking_id and h.consumed_at is null;
  else
    v_existing := case
      when jsonb_typeof(v_base -> 'reassignments') = 'array' then v_base -> 'reassignments'
      else '[]'::jsonb
    end;
    update bookings b set
      assigned_user_id  = p_user_id,
      agent_name        = p_agent_name,
      agent_email       = p_agent_email,
      gcal_event_id     = p_gcal_event_id,
      bucket_id         = v_bucket.id,
      allow_double_book = false,
      routing_trace     = jsonb_set(
        v_base, '{reassignments}',
        v_existing || jsonb_build_array(
          jsonb_build_object('from', v_bk.assigned_user_id::text, 'to', p_user_id::text, 'at', now())),
        true)
    where b.id = p_booking_id;

    update reassign_intents ri set
      prev_agent_email   = v_bk.agent_email,
      prev_gcal_event_id = v_bk.gcal_event_id,
      swapped_at         = now()
    where ri.booking_id = p_booking_id
      and ri.gcal_client_id = p_gcal_client_id;

    update reroute_holds h set
      consumed_at = now(),
      result = coalesce(p_result, '{}'::jsonb) || jsonb_build_object(
        'outcome',            'moved',
        'agent_user_id',      p_user_id,
        'bucket_id',          v_bucket.id,
        'bucket_code',        v_bucket.code,
        'prev_agent_user_id', v_bk.assigned_user_id,
        'prev_agent_email',   v_bk.agent_email,
        'prev_gcal_event_id', v_bk.gcal_event_id,
        'at',                 now())
    where h.id = v_hold.id;
  end if;

  insert into routing_decisions (
    org_id, booking_id, bucket_code, bucket_id, requested_tier, booked_tier, chosen_user_id,
    tier_fallback, rungs_dropped, outcome, requested_code
  ) values (
    v_bk.org_id, p_booking_id, v_bucket.code, v_bucket.id, p_requested_tier, p_booked_tier, p_user_id,
    v_rungs > 0, v_rungs, 'rerouted', v_req_code
  );

  return query select
    case when v_keep then null::text else v_bk.gcal_event_id end,
    case when v_keep then null::text else v_bk.agent_email end,
    true, null::text;
end
$$;

revoke execute on function reassign_booking_swap(uuid, uuid, text, text, text, jsonb, text, uuid, uuid, text, text, int, uuid, jsonb)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. History and analytics
-- ---------------------------------------------------------------------------
-- A corrected bucket is its own history action, with the bucket it left and the
-- one it landed in. No foreign key on the bucket columns, deliberately: booking_events
-- is append only (0089), so an ON DELETE SET NULL would raise on a bucket delete.
alter table booking_events drop constraint booking_events_action_check;
alter table booking_events add constraint booking_events_action_check
  check (action in ('rescheduled', 'cancelled', 'reassigned', 'bucket_corrected'));
alter table booking_events
  add column if not exists from_bucket_id uuid,
  add column if not exists to_bucket_id   uuid;

-- A reroute's own outcome, so the monitors counting outcome = 'booked' as bookings
-- never count one booking twice.
alter table routing_decisions drop constraint routing_decisions_outcome_check;
alter table routing_decisions add constraint routing_decisions_outcome_check
  check (outcome in ('booked', 'no_availability', 'no_eligible_agents', 'error', 'rerouted'));
