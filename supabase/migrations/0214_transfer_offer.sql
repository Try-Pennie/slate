-- #4380: offer a live transfer ("Call me now") on the coordinator booking page when
-- enough advisors are free in Pennie's transfer queue.
--
-- 1. booking_settings.transfer_offer_threshold: how many free advisors the transfer queue
--    endpoint must report before the page offers "Transfer now". The count is approximate
--    and reserves nothing, so it is a setting a super admin moves, never a constant (3
--    was suggested and is the default). NOT NULL DEFAULT 3, between 1 and 100.
-- 2. booking_settings.transfer_line: the line the partner agent transfers the customer
--    to, written as the page shows it (786-504-0671). NOT NULL DEFAULT '786-504-0671',
--    held to that one shape by a check, so the page never draws a half typed number.
-- 3. transfer_queue_days: what the monitor lane's business hours probe measured, one row
--    per business day in the org's zone: how many readings succeeded, how many were at
--    or above the threshold then in force, the most advisors seen free, and the first and
--    last reading. The "never reached the threshold across a whole business day" alarm is
--    judged from it, and only on a day the probe measured from open to close. No lead
--    data and nothing about any offer the page made (Slate cannot see whether a transfer
--    happened): counts and instants. Kept for good (Dan, 2026-10-29). Not mirrored to
--    Snowflake.
-- 4. record_transfer_queue_reading: the one writer of that table, one atomic upsert per
--    reading, so two ticks overlapping (assume it runs twice) each count once and the
--    running tallies never lose an increment to a read then write.
--
-- Additive only, so the code deployed when this is applied keeps working: it names none
-- of these columns, the table or the function.

alter table booking_settings
  add column transfer_offer_threshold integer not null default 3
    check (transfer_offer_threshold between 1 and 100),
  add column transfer_line text not null default '786-504-0671'
    check (transfer_line ~ '^[0-9]{3}-[0-9]{3}-[0-9]{4}$');

comment on column booking_settings.transfer_offer_threshold is
  'Free advisors in the transfer queue at or above which the coordinator booking page offers Transfer now (#4380). NOT NULL DEFAULT 3; a super admin sets it on /admin/coordinator-booking.';
comment on column booking_settings.transfer_line is
  'The line a partner agent transfers the customer to from the coordinator booking page (#4380), as the page shows it. NOT NULL DEFAULT 786-504-0671; a super admin sets it on /admin/coordinator-booking.';

create table transfer_queue_days (
  day date primary key,
  readings integer not null check (readings >= 1),
  reached integer not null check (reached >= 0 and reached <= readings),
  most_free integer not null check (most_free >= 0),
  first_read_at timestamptz not null,
  last_read_at timestamptz not null,
  check (first_read_at <= last_read_at)
);

alter table transfer_queue_days enable row level security;
-- No policies: default deny. Only the secret key server client (which bypasses RLS)
-- reads and writes it, through the function below.

comment on table transfer_queue_days is
  'What the monitor lane''s transfer queue probe measured per business day (#4380): readings, readings at or above the threshold, the most advisors free, the first and last reading. Written only by record_transfer_queue_reading; kept for good.';

create or replace function record_transfer_queue_reading(
  p_day date,
  p_free integer,
  p_reached boolean
) returns void
language sql
set search_path = public
as $$
  insert into transfer_queue_days as d (day, readings, reached, most_free, first_read_at, last_read_at)
  values (p_day, 1, case when p_reached then 1 else 0 end, p_free, now(), now())
  on conflict (day) do update set
    readings = d.readings + 1,
    reached = d.reached + case when p_reached then 1 else 0 end,
    most_free = greatest(d.most_free, excluded.most_free),
    first_read_at = least(d.first_read_at, excluded.first_read_at),
    last_read_at = greatest(d.last_read_at, excluded.last_read_at);
$$;

revoke execute on function record_transfer_queue_reading(date, integer, boolean) from public, anon, authenticated;
