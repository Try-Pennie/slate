-- #4103: Booking pace on Team capacity. Each capacity fill reading now carries the day's pace and
-- both estimates of when it reaches 95% full, which the day cards read (#4104). The rules are
-- src/lib/admin/capacity-pace.ts; the lane writes their answers as they are.
--
-- WHAT CHANGES. One new column, pace_back_at, the half hour a missed pace returns ("Readings
-- missed, pace back by 6:30pm"). record_capacity_fill now stores the pace and estimate columns
-- 0198 added unwritten; its signature is unchanged, so the code already deployed keeps working (a
-- row without the new keys stores them as null). capacity_fill_pattern answers the pattern's
-- cells for the estimate.
--
-- THE PATTERN. A cell is the average calls taken in one half hour, per day position and half hour
-- of the office's day, for all days together (weekday null) and per weekday. Only readings
-- measured over exactly one half hour count, so a reading after a gap is never averaged in as if
-- it were one half hour. No zone arithmetic here: day_position, slot_of_day and weekday are the
-- columns the lane wrote with one Luxon helper (officeSlot). The answer is one jsonb array rather
-- than a table, since a cell per position, half hour and weekday grouping can pass the 1,000 rows a
-- table answer is cut at.

alter table capacity_fill_readings
  add column pace_back_at timestamptz,
  add constraint capacity_fill_readings_pace_state
    check (pace_state is null or pace_state in ('pace', 'not-filling', 'no-pace-yet', 'readings-missed')),
  add constraint capacity_fill_readings_estimate_line_state
    check (estimate_line_state is null or estimate_line_state in ('already', 'at', 'wont-fill', 'no-pace', 'no-capacity')),
  add constraint capacity_fill_readings_estimate_pattern_state
    check (estimate_pattern_state is null or estimate_pattern_state in ('already', 'at', 'wont-fill', 'no-pace', 'no-capacity')),
  add constraint capacity_fill_readings_estimate_method
    check (estimate_method is null or estimate_method in ('line', 'pattern')),
  -- A time exactly when the state is one.
  add constraint capacity_fill_readings_estimate_line_at
    check ((estimate_line_at is not null) = (estimate_line_state is not distinct from 'at')),
  add constraint capacity_fill_readings_estimate_pattern_at
    check ((estimate_pattern_at is not null) = (estimate_pattern_state is not distinct from 'at')),
  add constraint capacity_fill_readings_pace_back_at
    check ((pace_back_at is not null) = (pace_state is not distinct from 'readings-missed'));

comment on column capacity_fill_readings.pace_back_at is
  'The half hour a missed pace returns, when pace_state is readings-missed (#4103); null otherwise.';

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
    estimate_pattern_state, estimate_pattern_at, estimate_method, estimate_cells_fallen_back
  )
  select p_org, p_read_at, r.day, r.day_position, r.slot_of_day, r.weekday, r.prev_read_at, r.taken,
         r.taken_reason, r.open, r.capacity, r.comparable_share, r.excluded_not_syncing,
         r.excluded_left_pool, r.excluded_capacity_changed,
         r.pace_state, r.pace_per_hour, r.pace_back_at, r.estimate_line_state, r.estimate_line_at,
         r.estimate_pattern_state, r.estimate_pattern_at, r.estimate_method, r.estimate_cells_fallen_back
  from jsonb_to_recordset(p_rows) as r(
    day date, day_position int, slot_of_day int, weekday int, prev_read_at timestamptz, taken numeric,
    taken_reason text, open int, capacity int, comparable_share numeric, excluded_not_syncing int,
    excluded_left_pool int, excluded_capacity_changed int,
    pace_state text, pace_per_hour numeric, pace_back_at timestamptz, estimate_line_state text,
    estimate_line_at timestamptz, estimate_pattern_state text, estimate_pattern_at timestamptz,
    estimate_method text, estimate_cells_fallen_back int
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

create or replace function capacity_fill_pattern(p_org uuid, p_since timestamptz)
returns jsonb
language sql
stable
set search_path = public
as $$
  with measured as (
    select day_position, slot_of_day, weekday, taken
    from capacity_fill_readings
    where org_id = p_org
      and read_at >= p_since
      and taken is not null
      and day_position is not null
      and prev_read_at = read_at - interval '30 minutes'
  ),
  cells as (
    select day_position, slot_of_day, null::int as weekday, avg(taken) as avg_taken, count(*)::int as samples
    from measured group by day_position, slot_of_day
    union all
    select day_position, slot_of_day, weekday, avg(taken), count(*)::int
    from measured group by day_position, slot_of_day, weekday
  )
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'day_position', day_position, 'slot_of_day', slot_of_day, 'weekday', weekday,
      'avg_taken', round(avg_taken, 4), 'samples', samples
    ) order by day_position, slot_of_day, weekday nulls first),
    '[]'::jsonb
  )
  from cells;
$$;

-- Server only, through the secret key client.
revoke execute on function capacity_fill_pattern(uuid, timestamptz) from public, anon, authenticated;
