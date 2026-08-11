-- #1313: page when customers are failing to complete bookings.
--
-- On 2026-08-06 cal.com refused more than 50 confirms in about two hours and
-- reported nothing; the only detector was Pennie's SMS complaint monitor. Slate
-- already counts every attempt (#418, and both booker routes record one), but
-- booking_api_outcome_daily is bucketed by DAY, and a wave of fifty refusals is
-- invisible inside a day's worth of successes.
--
-- Rather than re-key that table by hour (which would rewrite its unique key and
-- its increment RPC), this stores ONE row of monitor state. The daily tally is
-- monotonic within a day, so two consecutive reads give a delta; the monitor lane
-- runs every 5 minutes and accumulates those deltas into the rolling window held
-- here, giving 5-minute resolution over any window length.
--
-- `samples` is the window itself: an array of {atMs, attempts, failures, byCode}
-- objects, each one interval's measured delta, pruned as they age out. Twelve or
-- so entries at any time, so it stays small. The other columns are the baseline
-- the NEXT delta is measured against: the ET day it belongs to (so the midnight
-- counter reset is detectable rather than arriving as a negative delta), and that
-- reading's cumulative totals.
--
-- Single row, keyed by a fixed text key, so it can never grow: roster-bounded for
-- the capped-read guard (added to SAFE_TABLES in the same change) and classified
-- as a lock/counter in the singleton guard.
create table booking_failure_rate_state (
  key        text primary key,
  day        date not null,
  attempts   bigint not null,
  failures   bigint not null,
  by_code    jsonb not null default '{}'::jsonb,
  samples    jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table booking_failure_rate_state enable row level security;
-- No policies: default-deny. Only the secret-key server client (which bypasses
-- RLS) reads and writes this monitor state.

-- The arming switch, mirroring low_volume_armed (#575) exactly: same single-row
-- config table, same precedence (store > env > coded default), same admin form.
--
-- Nullable on purpose, and the coded default is DISARMED. Per L56 a new detector
-- must observe one real cycle before it is allowed to page, so that a genuine
-- first finding does not page off a threshold nobody has yet seen against real
-- traffic. The issue that flips it is filed in the same change (L65), because an
-- observe-only guard becomes invisible the moment the reason for it is forgotten.
alter table monitor_alert_config
  add column failure_rate_armed boolean;
