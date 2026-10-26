-- #4222: a cron lane sent twice for the same tick runs once.
--
-- The Worker's dispatcher sends each scheduled lane as a request carrying its tick's id
-- (x-slate-tick-id). The relay that will place lanes near the database (#4189) fails as
-- a rejected call, and on that failure the dispatcher will send the lane again by
-- today's route rather than skip the run. So every scheduled lane route claims
-- (tick_id, lane) here before any work: a plain insert, and the primary key decides.
-- Of any number of deliveries of one lane for one tick, sequential or at the same
-- moment, exactly one insert succeeds and runs the lane; every other one meets 23505
-- and answers "duplicate" without doing anything. The rules are
-- src/lib/monitor/lane-claim.ts; the constraint is proved in a real Postgres by
-- scripts/verify-lane-runs-sql.ts.
--
-- A GROWTH table: about 7,600 rows a day at today's schedule. Pruned to two days by
-- the daily 03:05 prune-regal-calls lane (LANE_RUN_RETENTION_DAYS), on claimed_at,
-- which is what the index is for. No lead or agent data: a tick id we mint, a lane
-- name from the schedule, and an instant. Not mirrored to Snowflake.
--
-- Server only, through the secret key client: RLS on with no policy, so every API
-- role is refused.

create table lane_runs (
  -- The tick's id as worker/lane-run.ts mints it (mintTickId: 16 hex characters).
  tick_id    text not null check (tick_id ~ '^[a-f0-9]{1,32}$'),
  -- The lane as laneFieldName names it (/api/cron/prune-routing is prune_routing).
  lane       text not null check (lane ~ '^[a-z0-9_]{1,40}$'),
  claimed_at timestamptz not null default now(),
  primary key (tick_id, lane)
);

alter table lane_runs enable row level security;

create index lane_runs_claimed_at_idx on lane_runs (claimed_at);

comment on table lane_runs is
  'Each scheduled cron lane''s claim on its tick (#4222): the primary key lets one delivery of a lane per tick run, so a lane re-sent after a relay failure does nothing. Pruned to two days by the prune-regal-calls lane.';
