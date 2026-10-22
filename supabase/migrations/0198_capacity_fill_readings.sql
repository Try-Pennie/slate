-- #4102: Booking pace on Team capacity. Every half hour, a reading of each page day's
-- calls open and how many were taken since the last reading, so the pace a day fills
-- at (#4103) is worked out from what really happened.
--
-- HOW TAKEN IS MEASURED. The capacity-fill lane reads at the half hour it falls in
-- (read_at). For every page day it saves the counted team's calls open and capacity,
-- and a snapshot of each counted advisor (open, capacity, and a fingerprint of where
-- the capacity's calls start). The next reading judges the calendar as it is NOW at
-- the PREVIOUS reading's instant, so time passing cancels and a booking for the very
-- next times still counts. Taken is null with its reason, never 0, when under the
-- comparable share floor of the team could be compared (an office hours edit, a
-- Google outage, a bulk time off approval). The rules are
-- src/lib/admin/capacity-fill.ts; no zone arithmetic happens here: slot_of_day and
-- weekday are written by one Luxon helper (officeSlot).
--
-- RUNS TWICE SAFELY. record_capacity_fill writes only when the org's latest snapshot
-- is still the one the run read from and the run's half hour is later than it, under
-- a per org transaction lock. Readings insert on conflict do nothing. So a second run
-- in the same half hour, even after a calendar change, leaves every row as it was.
--
-- KEPT FOR GOOD unless Dan chooses otherwise: about 240 readings a day. No lead
-- contact data: ids, counts and instants only. Not mirrored to Snowflake.

create table capacity_fill_readings (
  org_id      uuid not null references organizations(id) on delete cascade,
  -- The half hour the reading was taken at.
  read_at     timestamptz not null check (extract(epoch from read_at)::bigint % 1800 = 0),
  -- The office day read.
  day         date not null,
  -- The day's index among the booker's days; null for a page day the booker no longer
  -- offers (today after the 6 PM cutoff).
  day_position int check (day_position >= 0),
  -- The half hour of the office's day (0 to 47) and its weekday (1 = Monday) at read_at,
  -- in the office's zone.
  slot_of_day int not null check (slot_of_day between 0 and 47),
  weekday     int not null check (weekday between 1 and 7),
  -- The earlier reading taken was measured from; null when there was none.
  prev_read_at timestamptz check (prev_read_at < read_at),
  -- Calls taken since prev_read_at, scaled from the comparable advisors to the counted
  -- team. Negative when more was given back (a cancellation) than taken.
  taken        numeric,
  taken_reason text check (taken_reason in ('first-reading', 'too-long-since', 'too-few-comparable', 'no-capacity')),
  -- The counted team's calls open and capacity at read_at, as the page totals them.
  open         int not null check (open >= 0),
  capacity     int not null check (capacity >= 0),
  -- Comparable capacity over counted capacity at prev_read_at.
  comparable_share numeric check (comparable_share between 0 and 1),
  excluded_not_syncing      int not null default 0 check (excluded_not_syncing >= 0),
  excluded_left_pool        int not null default 0 check (excluded_left_pool >= 0),
  excluded_capacity_changed int not null default 0 check (excluded_capacity_changed >= 0),
  -- #4103 writes these: the day's filling pace and when it will reach 95% full, both
  -- methods from day one. Nullable and unwritten here.
  pace_per_hour           numeric,
  pace_state              text,
  estimate_line_at        timestamptz,
  estimate_line_state     text,
  estimate_pattern_at     timestamptz,
  estimate_pattern_state  text,
  estimate_method         text,
  estimate_cells_fallen_back int,
  created_at  timestamptz not null default now(),
  primary key (org_id, read_at, day),
  -- Taken is known, or unknown with its reason: never both, never neither.
  constraint capacity_fill_readings_taken_or_reason check ((taken is null) = (taken_reason is not null))
);

alter table capacity_fill_readings enable row level security;

comment on table capacity_fill_readings is
  'Booking pace on Team capacity (#4102): per org, half hour and page day, the calls open and how many were taken since the last reading (null with its reason when too little of the team could be compared, never 0). Written by the capacity-fill lane through record_capacity_fill. Kept for good.';

-- Each page day's last snapshot: what the next reading compares with.
create table capacity_fill_last (
  org_id   uuid not null references organizations(id) on delete cascade,
  day      date not null,
  read_at  timestamptz not null,
  -- {"<user id>": {"open": n, "capacity": n, "fp": "<capacity fingerprint>"}}, counted
  -- advisors only.
  snapshot jsonb not null,
  primary key (org_id, day)
);

alter table capacity_fill_last enable row level security;

comment on table capacity_fill_last is
  'The last capacity fill snapshot per org and office day (#4102): each counted advisor''s calls open, capacity and capacity fingerprint at read_at. Moved only forward by record_capacity_fill.';

-- One run's readings and snapshots, in one transaction. Returns whether it wrote:
-- false when another run already moved the org's snapshots past p_prev_read_at, or
-- p_read_at is not later than them.
create or replace function record_capacity_fill(
  p_org uuid,
  p_read_at timestamptz,
  p_prev_read_at timestamptz,
  p_rows jsonb,
  p_last jsonb
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  latest timestamptz;
begin
  -- One writer per organisation at a time, so the check below holds until commit.
  perform pg_advisory_xact_lock(hashtextextended('record_capacity_fill:' || p_org::text, 0));

  select max(read_at) into latest from capacity_fill_last where org_id = p_org;
  if latest is distinct from p_prev_read_at or p_read_at <= latest then
    return false;
  end if;

  insert into capacity_fill_readings (
    org_id, read_at, day, day_position, slot_of_day, weekday, prev_read_at, taken, taken_reason,
    open, capacity, comparable_share, excluded_not_syncing, excluded_left_pool, excluded_capacity_changed
  )
  select p_org, p_read_at, r.day, r.day_position, r.slot_of_day, r.weekday, r.prev_read_at, r.taken,
         r.taken_reason, r.open, r.capacity, r.comparable_share, r.excluded_not_syncing,
         r.excluded_left_pool, r.excluded_capacity_changed
  from jsonb_to_recordset(p_rows) as r(
    day date, day_position int, slot_of_day int, weekday int, prev_read_at timestamptz, taken numeric,
    taken_reason text, open int, capacity int, comparable_share numeric, excluded_not_syncing int,
    excluded_left_pool int, excluded_capacity_changed int
  )
  on conflict (org_id, read_at, day) do nothing;

  insert into capacity_fill_last as l (org_id, day, read_at, snapshot)
  select p_org, s.day, p_read_at, s.snapshot
  from jsonb_to_recordset(p_last) as s(day date, snapshot jsonb)
  on conflict (org_id, day) do update
    set read_at = excluded.read_at, snapshot = excluded.snapshot
    where l.read_at < excluded.read_at;

  return true;
end;
$$;

-- Server only, through the secret key client.
revoke execute on function record_capacity_fill(uuid, timestamptz, timestamptz, jsonb, jsonb) from public, anon, authenticated;
