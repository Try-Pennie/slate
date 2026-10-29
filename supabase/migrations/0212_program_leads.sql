-- #4387 (Phase 1 of #4255): program leads and the placeholder day limit.
--
-- A program lead is a Salesforce Lead that Bidspoke registers when it accepts the lead
-- (#4388). For 30 days its texted booking link may book a time when no real advisor is
-- free, on the placeholder advisor (0207, 0208), up to booking_settings.placeholder_day_limit
-- such calls on one Eastern day, counted by the day of the CALL (Dan, 2026-10-29).
--
-- 1. program_leads: one row per Lead, keyed by its 15 character id (leadIdKey, so the 15
--    and 18 character spellings are one lead). Registering again extends the mark, never
--    shortens it. Rows are kept after they lapse: they are the only record of when a lead
--    was recognised, and the table grows by one row per accepted lead.
-- 2. bookings.program_lead: written when a program lead's booking is made and carried
--    through every move by the row itself, so the record outlives the 30 day mark.
-- 3. booking_settings.placeholder_day_limit, 0 to 500, starting at 50.
-- 4. The HELD count for a day is DERIVED, never stored, so nothing has to remember to
--    release a place: active program bookings on a placeholder starting that Eastern day,
--    in the real world, plus fresh claims (placeholder_day_claims, under 15 minutes old)
--    whose booking has not committed yet. A cancel, a move off the placeholder and a move
--    to another day free the place by construction; a claim whose booking committed under
--    its key (or, for a move, whose booking now sits on that day) is counted once, as the
--    booking; a claim that never committed lapses. placeholder_day_held is the one
--    predicate, read by the claim and by the per day counts the booking page shows.
-- 5. claim_placeholder_day: under a transaction advisory lock on the day, grants a place
--    while held is under the limit, leaving out the moving booking's own place. A claim
--    already made under the same key is granted again (a retry) without a second place.
--    The caller claims BEFORE the reservation and the calendar invite (#4391).
--
-- Additive only: two new tables, two columns with defaults and four functions nothing
-- deployed calls, so the deployed code keeps working from the apply to the deploy.
-- Proved in a real Postgres by scripts/verify-program-leads-sql.ts.

create table program_leads (
  lead_key           text primary key
                     constraint program_leads_lead_key_shape check (lead_key ~ '^00Q[0-9A-Za-z]{12}$'),
  registered_by      text not null,
  registered_at      timestamptz not null default now(),
  last_registered_at timestamptz not null default now(),
  expires_at         timestamptz not null
);
alter table program_leads enable row level security;

comment on table program_leads is
  'Leads registered by Bidspoke for the program (#4255): a live row (expires_at in the future) lets the texted booking link use the placeholder advisor. Kept after it lapses as the record of when a lead was recognised.';

alter table bookings add column program_lead boolean not null default false;

-- The held count reads program bookings on the placeholder by start; the partial index
-- keeps that read to the few rows it is about, whatever bookings grows to.
create index bookings_program_placeholder_start
  on bookings (starts_at)
  where program_lead and kind = 'staff_placed' and status in ('confirmed', 'rescheduled');

alter table booking_settings add column placeholder_day_limit integer not null default 50
  constraint booking_settings_placeholder_day_limit_range check (placeholder_day_limit between 0 and 500);

create table placeholder_day_claims (
  claim_key  text primary key,
  call_day   date not null,
  booking_id uuid references bookings(id) on delete cascade,
  claimed_at timestamptz not null default now()
);
alter table placeholder_day_claims enable row level security;
create index placeholder_day_claims_day on placeholder_day_claims (call_day, claimed_at);

comment on table placeholder_day_claims is
  'A place on a day''s placeholder limit taken by a program booking still in flight (#4387). Counts for 15 minutes or until its booking commits, whichever is first; never deleted.';

create or replace function register_program_lead(p_lead_key text, p_caller text)
  returns timestamptz
  language plpgsql
  volatile
  set search_path = public, pg_catalog
as $$
declare
  v_expires timestamptz;
begin
  if p_lead_key is null or p_lead_key !~ '^00Q[0-9A-Za-z]{12}$' then
    raise exception 'register_program_lead: % is not a 15 character Lead key', coalesce(p_lead_key, 'null')
      using errcode = '22023';
  end if;
  insert into program_leads as p (lead_key, registered_by, expires_at)
  values (p_lead_key, p_caller, now() + interval '30 days')
  on conflict (lead_key) do update
    set last_registered_at = now(),
        registered_by      = excluded.registered_by,
        expires_at         = greatest(p.expires_at, excluded.expires_at)
  returning expires_at into v_expires;
  return v_expires;
end;
$$;

-- The one predicate for what holds a place on a day. p_exclude_booking is the booking
-- being moved, which never counts against its own move.
create or replace function placeholder_day_held(p_day date, p_exclude_booking uuid)
  returns integer
  language sql
  stable
  set search_path = public, pg_catalog
as $$
  with day_bounds as (
    select (p_day::timestamp at time zone 'America/New_York') as day_start,
           ((p_day + 1)::timestamp at time zone 'America/New_York') as day_end
  ),
  counted as (
    select b.id, b.idempotency_key
      from bookings b
      join buckets k on k.id = b.bucket_id
      join users u on u.id = b.assigned_user_id
      cross join day_bounds d
     where b.program_lead
       and b.kind = 'staff_placed'
       and b.status in ('confirmed', 'rescheduled')
       and u.is_placeholder
       and not k.is_test
       and b.starts_at >= d.day_start
       and b.starts_at <  d.day_end
  )
  select (
    (select count(*) from counted where id is distinct from p_exclude_booking)
    +
    (select count(*)
       from placeholder_day_claims c
      where c.call_day = p_day
        and c.claimed_at > now() - interval '15 minutes'
        -- Only a claim FOR the moving booking is left out; with no booking moving, a
        -- claim with no booking (a new call in flight) counts (null is not distinct
        -- from null, so a bare comparison would drop every such claim).
        and (p_exclude_booking is null or c.booking_id is distinct from p_exclude_booking)
        -- A claim stops being in flight once its write landed, wherever the booking is
        -- now (counted above if it is still on this day's placeholder): a new call's once
        -- any booking carries its key, a move's once its booking was written after the
        -- claim (bookings_updated_at stamps every write).
        and not exists (
          select 1 from bookings b
           where (c.booking_id is null and b.idempotency_key = c.claim_key)
              or (c.booking_id is not null and b.id = c.booking_id and b.updated_at > c.claimed_at)
        )
        -- A move within the day of a booking already holding a place there is that one
        -- place, not a second.
        and not exists (select 1 from counted x where x.id = c.booking_id))
  )::integer;
$$;

create or replace function claim_placeholder_day(p_day date, p_claim_key text, p_booking_id uuid)
  returns boolean
  language plpgsql
  volatile
  set search_path = public, pg_catalog
as $$
declare
  v_limit integer;
begin
  -- One claim at a time per day, so two requests for the last place cannot both see it.
  perform pg_advisory_xact_lock(hashtextextended('placeholder_day:' || p_day::text, 0));

  -- A retry of a claim still holding its place keeps it. A lapsed one is judged afresh,
  -- or a retry long after the day filled would take a place nobody gave it.
  if exists (select 1 from placeholder_day_claims
              where claim_key = p_claim_key and call_day = p_day
                and claimed_at > now() - interval '15 minutes') then
    update placeholder_day_claims set claimed_at = now() where claim_key = p_claim_key;
    return true;
  end if;

  select placeholder_day_limit into v_limit from booking_settings where id = 1;
  if v_limit is null then
    raise exception 'claim_placeholder_day: booking_settings has no placeholder_day_limit'
      using errcode = '55000';
  end if;
  if placeholder_day_held(p_day, p_booking_id) >= v_limit then
    return false;
  end if;

  insert into placeholder_day_claims (claim_key, call_day, booking_id)
  values (p_claim_key, p_day, p_booking_id)
  on conflict (claim_key) do update
    set call_day = excluded.call_day, booking_id = excluded.booking_id, claimed_at = now();
  return true;
end;
$$;

create or replace function placeholder_day_counts(p_from date, p_to date)
  returns table (call_day date, held integer)
  language sql
  stable
  set search_path = public, pg_catalog
as $$
  select d::date, placeholder_day_held(d::date, null)
    from generate_series(p_from, p_to, interval '1 day') as d;
$$;

-- Server side only. service_role keeps its EXECUTE from the default privileges 0121 sets.
revoke execute on function register_program_lead(text, text) from public, anon, authenticated;
revoke execute on function placeholder_day_held(date, uuid) from public, anon, authenticated;
revoke execute on function claim_placeholder_day(date, text, uuid) from public, anon, authenticated;
revoke execute on function placeholder_day_counts(date, date) from public, anon, authenticated;
