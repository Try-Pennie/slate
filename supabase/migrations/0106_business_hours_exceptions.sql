-- Specific dates the org is shut (or open) regardless of the weekly pattern (#1363).
--
-- `business_hours` (0098) stores one row per weekday, so the org's opening hours
-- are a weekly pattern and nothing else. There was no way to say "shut for
-- Christmas week" or "closed Thanksgiving", which matters because the two
-- features most obviously written for a holiday shutdown could never fire for
-- one: #1328's honest closure copy ("We are closed until Monday, August 17") and
-- #1329's button revealing the first days back both derive "closed" from the
-- weekly pattern alone. During Christmas week the booker would have reported the
-- emptiness as demand ("All times are taken right now"), which is the exact
-- untruth #1328 set out to remove.
--
-- An exception can also OPEN a normally shut day, because it is the same table
-- either way and a one off Saturday is as real a need as a holiday.
--
-- Keyed on the date, like `business_hours` is keyed on the weekday: one row per
-- date, so an exception can never be stored twice and the resolver never has to
-- decide which of two rows for one day wins. No org column, matching its sibling:
-- Slate is single org and `business_hours` made the same call.
create table business_hours_exceptions (
  on_date      date primary key,
  -- False shuts the date whatever the weekday says; true opens it, and then the
  -- window below replaces the weekday's.
  is_open      boolean  not null default false,
  -- Null on a closed date: there is no window, and storing a fake one would let a
  -- later reader treat a closure as an open day with odd hours.
  start_minute smallint check (start_minute >= 0 and start_minute < 1440),
  -- 1440 is midnight at the end of the day, which the compute treats as a valid
  -- bound, so the ceiling is inclusive here and exclusive on the start, exactly
  -- as in business_hours.
  end_minute   smallint check (end_minute > 0 and end_minute <= 1440),
  -- Why, so the admin list reads as a list of holidays rather than of dates.
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references users(id) on delete set null,
  -- An OPEN exception must carry a usable window, and a CLOSED one must not carry
  -- one at all. Enforced here rather than in application code because this table
  -- gates what a lead is offered, and a half filled row would widen or narrow the
  -- day silently.
  constraint business_hours_exceptions_window_present check (
    (is_open and start_minute is not null and end_minute is not null and end_minute > start_minute)
    or (not is_open and start_minute is null and end_minute is null)
  )
);

-- Server reads/writes via the secret-key admin client; no client access.
alter table business_hours_exceptions enable row level security;

comment on table business_hours_exceptions is
  'Specific dates the org is shut or open, overriding the weekly business_hours pattern (#1363).';
