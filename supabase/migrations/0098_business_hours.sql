-- Org business hours: gate 1 of the three booking gates (#1255, #1294).
--
-- A time is offered to a customer only if it is inside the ORG's open hours, inside
-- some agent's own hours, and free on that agent's calendar. Nothing capped the day
-- org-wide before this, so an agent's schedule was the only thing deciding how late
-- Slate would offer, and there was nowhere for "when is Pennie open" to live.
--
-- SEVEN ROWS, not a jsonb blob on booking_settings, so the constraints that keep a
-- window sane live in Postgres where no buggy form can get past them. Seven rows on
-- a fixed 1..7 key space can never grow, so this is roster-bounded for the capped
-- read guard (added to SAFE_TABLES in the same change).
--
-- The SAME columns as availability_rules (weekday, start_minute, end_minute), on
-- purpose: gate 1 is then a second call to the existing isWithinWorkingHours
-- predicate rather than a parallel implementation of the same idea. Minutes are from
-- local midnight and weekdays follow Luxon (1 = Monday .. 7 = Sunday), matching every
-- other schedule in Slate.
--
-- is_open is a FLAG rather than an absent row, because absent and closed have to mean
-- different things: no rows at all is "not configured" and falls back to the seeded
-- week (a gate resolving an empty table to "closed" would blank the booker), while a
-- day stored as closed is a decision and does close that day.
--
-- The timezone is deliberately NOT stored. The org clock is a coded constant
-- (BUSINESS_ZONE, America/New_York); making it admin-editable is a named deferral.
-- Each AGENT's own hours already carry their own timezone, which is unaffected.
create table business_hours (
  weekday      smallint primary key check (weekday between 1 and 7),
  is_open      boolean  not null default true,
  start_minute smallint not null check (start_minute >= 0 and start_minute < 1440),
  -- 1440 is midnight at the end of the day, which the compute treats as a valid
  -- bound, so the ceiling is inclusive here and exclusive on the start.
  end_minute   smallint not null check (end_minute > 0 and end_minute <= 1440),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references users(id) on delete set null,
  constraint business_hours_window_ordered check (end_minute > start_minute)
);

-- Server reads/writes via the secret-key admin client; no client access.
alter table business_hours enable row level security;

-- Seeded Monday to Saturday 8:00 to 20:00, Sunday closed (Dan's decision,
-- 2026-08-05). Sunday keeps a valid window rather than a placeholder, so opening it
-- later is one flag flip and can never leave a nonsense window behind.
insert into business_hours (weekday, is_open, start_minute, end_minute) values
  (1, true,  480, 1200),
  (2, true,  480, 1200),
  (3, true,  480, 1200),
  (4, true,  480, 1200),
  (5, true,  480, 1200),
  (6, true,  480, 1200),
  (7, false, 480, 1200);
