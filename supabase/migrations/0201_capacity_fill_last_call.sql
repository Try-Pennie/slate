-- #4190: Booking pace on Team capacity. From 95% a day card's Full by is when its last open call
-- is taken (Dan, 2026-10-23, #4101 decision 20), so a reading of a day already at 95% also carries
-- that estimate, by both methods. The rules are src/lib/admin/capacity-pace.ts (target
-- "last-call"); the lane writes their answers as they are.
--
-- WHAT CHANGES. Five new columns, null on a day under 95% and on every reading before this. They
-- are their own columns, never the 95% ones, because #4105 compares the saved 95% estimates with
-- when each day really reached 95%. record_capacity_fill now stores them; its signature is
-- unchanged (the rows are one jsonb array), so the code already deployed keeps working while this
-- is applied ahead of it: a row without the new keys stores them as null.

alter table capacity_fill_readings
  add column estimate_last_line_state text,
  add column estimate_last_line_at timestamptz,
  add column estimate_last_pattern_state text,
  add column estimate_last_pattern_at timestamptz,
  add column estimate_last_method text,
  add constraint capacity_fill_readings_estimate_last_line_state
    check (estimate_last_line_state is null or estimate_last_line_state in ('already', 'at', 'wont-fill', 'no-pace', 'no-capacity')),
  add constraint capacity_fill_readings_estimate_last_pattern_state
    check (estimate_last_pattern_state is null or estimate_last_pattern_state in ('already', 'at', 'wont-fill', 'no-pace', 'no-capacity')),
  add constraint capacity_fill_readings_estimate_last_method
    check (estimate_last_method is null or estimate_last_method in ('line', 'pattern')),
  add constraint capacity_fill_readings_estimate_last_line_at
    check ((estimate_last_line_at is not null) = (estimate_last_line_state is not distinct from 'at')),
  add constraint capacity_fill_readings_estimate_last_pattern_at
    check ((estimate_last_pattern_at is not null) = (estimate_last_pattern_state is not distinct from 'at')),
  -- All five are written together or not at all.
  add constraint capacity_fill_readings_estimate_last_together
    check ((estimate_last_line_state is null) = (estimate_last_pattern_state is null)
       and (estimate_last_line_state is null) = (estimate_last_method is null));

comment on column capacity_fill_readings.estimate_last_line_state is
  'From 95%, the straight line walk to no call open (#4190); null on a day under 95%.';
comment on column capacity_fill_readings.estimate_last_pattern_state is
  'From 95%, the pattern walk to no call open (#4190); null on a day under 95%.';
comment on column capacity_fill_readings.estimate_last_method is
  'The method the card shows for the last call estimate (#4190); null on a day under 95%.';

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
    open, capacity, comparable_share, excluded_not_syncing, excluded_left_pool, excluded_capacity_changed,
    pace_state, pace_per_hour, pace_back_at, estimate_line_state, estimate_line_at,
    estimate_pattern_state, estimate_pattern_at, estimate_method, estimate_cells_fallen_back,
    estimate_last_line_state, estimate_last_line_at, estimate_last_pattern_state,
    estimate_last_pattern_at, estimate_last_method
  )
  select p_org, p_read_at, r.day, r.day_position, r.slot_of_day, r.weekday, r.prev_read_at, r.taken,
         r.taken_reason, r.open, r.capacity, r.comparable_share, r.excluded_not_syncing,
         r.excluded_left_pool, r.excluded_capacity_changed,
         r.pace_state, r.pace_per_hour, r.pace_back_at, r.estimate_line_state, r.estimate_line_at,
         r.estimate_pattern_state, r.estimate_pattern_at, r.estimate_method, r.estimate_cells_fallen_back,
         r.estimate_last_line_state, r.estimate_last_line_at, r.estimate_last_pattern_state,
         r.estimate_last_pattern_at, r.estimate_last_method
  from jsonb_to_recordset(p_rows) as r(
    day date, day_position int, slot_of_day int, weekday int, prev_read_at timestamptz, taken numeric,
    taken_reason text, open int, capacity int, comparable_share numeric, excluded_not_syncing int,
    excluded_left_pool int, excluded_capacity_changed int,
    pace_state text, pace_per_hour numeric, pace_back_at timestamptz, estimate_line_state text,
    estimate_line_at timestamptz, estimate_pattern_state text, estimate_pattern_at timestamptz,
    estimate_method text, estimate_cells_fallen_back int,
    estimate_last_line_state text, estimate_last_line_at timestamptz, estimate_last_pattern_state text,
    estimate_last_pattern_at timestamptz, estimate_last_method text
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

revoke execute on function record_capacity_fill(uuid, timestamptz, timestamptz, jsonb, jsonb) from public, anon, authenticated;
