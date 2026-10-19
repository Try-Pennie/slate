-- #3940: Team capacity history, each advisor's calls saved as they pass, so a past
-- day on the Team capacity page shows how it ended (docs/design/team-capacity.html,
-- requirement 15, frame f9).
--
-- WHY. Nothing Slate holds can rebuild a past day later: working hours are kept only
-- as they are now, and past busy time is pruned after 36 hours. So history starts the
-- day this ships, written by the capacity-history lane every half hour.
--
-- WHAT A ROW IS. One advisor on one office day: the day's whole shift, approved time
-- off and capacity (calls the shift could hold, time off taken out), and every call
-- that was still open when it could no longer be booked. A call and its gap is half
-- an hour, so each saved call is one half hour that went unused; the rest of the
-- shift was booked or off. `unsynced` marks a day whose calendar was not syncing at
-- some tick, so its room cannot be trusted and the page counts it in neither total.
--
-- RUNS TWICE SAFELY. A tick writes through record_capacity_history, which merges
-- open_times as a set union and keeps unsynced once set, so a retried or overlapping
-- tick adds nothing it already added. The cursor only ever moves forward, in the same
-- transaction as the rows.
--
-- KEPT FOR GOOD (Dan, 2026-10-19): no retention prune. About 136 rows a day. No lead
-- contact data: ids, times and counts only. Not mirrored to Snowflake. Rows cascade
-- with their user like busy_blocks; users are deactivated, never deleted.
create table capacity_history (
  user_id     uuid not null references users(id) on delete cascade,
  day         date not null,
  -- The advisor's zone that day, for the short zone name beside them.
  timezone    text not null,
  capacity    int not null check (capacity >= 0),
  open_times  timestamptz[] not null default '{}',
  is_out      boolean not null,
  no_shift    boolean not null,
  unsynced    boolean not null default false,
  shift_start timestamptz,
  shift_end   timestamptz,
  -- [{"start": iso, "end": iso}], approved time off inside the day.
  time_off    jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (user_id, day)
);

-- The page reads one day for everybody.
create index capacity_history_day on capacity_history (day);

alter table capacity_history enable row level security;

comment on table capacity_history is
  'Team capacity history (#3940): per advisor and office day, the shift, time off, capacity and every call still open when it could no longer be booked. Written by the capacity-history lane through record_capacity_history. Kept for good.';

-- Where the last tick stopped, one row per organisation.
create table capacity_history_cursor (
  org_id           uuid primary key references organizations(id) on delete cascade,
  recorded_through timestamptz not null
);

alter table capacity_history_cursor enable row level security;

comment on table capacity_history_cursor is
  'How far the capacity-history lane has recorded (#3940): calls that stopped being bookable before recorded_through are saved. Only moves forward.';

-- One tick's rows and the cursor, in one transaction. Returns how many rows it wrote.
create or replace function record_capacity_history(p_org uuid, p_rows jsonb, p_through timestamptz)
returns integer
language plpgsql
set search_path = public
as $$
declare
  n integer;
begin
  insert into capacity_history as h (
    user_id, day, timezone, capacity, open_times, is_out, no_shift, unsynced,
    shift_start, shift_end, time_off, updated_at
  )
  select r.user_id, r.day, r.timezone, r.capacity, coalesce(r.open_times, '{}'), r.is_out, r.no_shift,
         r.unsynced, r.shift_start, r.shift_end, coalesce(r.time_off, '[]'::jsonb), now()
  from jsonb_to_recordset(p_rows) as r(
    user_id uuid, day date, timezone text, capacity int, open_times timestamptz[], is_out boolean,
    no_shift boolean, unsynced boolean, shift_start timestamptz, shift_end timestamptz, time_off jsonb
  )
  on conflict (user_id, day) do update set
    timezone = excluded.timezone,
    capacity = excluded.capacity,
    open_times = (
      select coalesce(array_agg(distinct t order by t), '{}')
      from unnest(h.open_times || excluded.open_times) as t
    ),
    is_out = excluded.is_out,
    no_shift = excluded.no_shift,
    unsynced = h.unsynced or excluded.unsynced,
    shift_start = excluded.shift_start,
    shift_end = excluded.shift_end,
    time_off = excluded.time_off,
    updated_at = now();
  get diagnostics n = row_count;

  insert into capacity_history_cursor (org_id, recorded_through)
  values (p_org, p_through)
  on conflict (org_id) do update
    set recorded_through = greatest(capacity_history_cursor.recorded_through, excluded.recorded_through);

  return n;
end;
$$;

-- Server only, through the secret key client.
revoke execute on function record_capacity_history(uuid, jsonb, timestamptz) from public, anon, authenticated;
