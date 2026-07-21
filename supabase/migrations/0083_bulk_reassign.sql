-- #973: bulk reassign an out agent's upcoming bookings for coverage (#562).
--
-- A serialized, resumable, idempotent background engine moves every active
-- upcoming booking assigned to an out agent, in a date range, onto a
-- live-verified covering agent (one booking at a time, so each committed move is
-- reflected in the daily-cap count the next pick sees). These two tables are its
-- durable state. Server-only: RLS default-deny; written and read via
-- supabaseAdmin (the secret-key client that bypasses RLS). NOT drained through
-- the generic non-serial booking outbox.

-- One coverage sweep. `status` is 'active' while it still has pending items, then
-- 'done' once every item reached a terminal outcome. The reason is a validated
-- reassign reason (core.ts REASSIGN_REASONS); `created_by` / `acting_as_user_id`
-- mirror the BookingActor accountable for the sweep (#549).
create table bulk_reassign_jobs (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id),
  out_user_id       uuid not null references users(id),
  range_start       timestamptz not null,
  range_end         timestamptz,
  reason_code       text not null,
  reason_detail     text,
  status            text not null default 'active' check (status in ('active', 'done')),
  created_by        uuid references users(id),
  acting_as_user_id uuid references users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (range_end is null or range_end > range_start)
);

-- One booking to move within a job. `status` is the item's terminal outcome:
--   pending     not yet processed (or a verify-outage retry)
--   moved       reassigned onto target_user_id (or already off the out agent)
--   unplaceable no eligible agent was live-free + under-cap at the original time
--   skipped     the booking was cancelled/completed/gone before we moved it
--   failed      exhausted retries on a real error
-- UNIQUE(job_id, booking_id) makes item creation idempotent: re-snapshotting a
-- job's bookings can never insert the same booking twice, and the drain keying
-- off booking assignment can never double-move one.
create table bulk_reassign_items (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references bulk_reassign_jobs(id) on delete cascade,
  booking_id     uuid not null references bookings(id),
  status         text not null default 'pending'
                   check (status in ('pending', 'moved', 'unplaceable', 'skipped', 'failed')),
  target_user_id uuid references users(id),
  detail         text,
  attempts       integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (job_id, booking_id)
);

-- The drain loads the oldest pending items across active jobs, bounded per tick.
-- A partial index keeps that query on just the unprocessed rows as terminal items
-- accumulate.
create index bulk_reassign_items_pending_idx
  on bulk_reassign_items (created_at)
  where status = 'pending';

-- Per-job item lookups (snapshot dedupe, status summary, job-done check).
create index bulk_reassign_items_job_idx on bulk_reassign_items (job_id);

-- Active-job scan for the drain.
create index bulk_reassign_jobs_active_idx on bulk_reassign_jobs (created_at)
  where status = 'active';

alter table bulk_reassign_jobs enable row level security;
alter table bulk_reassign_items enable row level security;
-- No policies: default-deny. Only the secret-key server client (which bypasses
-- RLS) writes and reads these engine tables.
