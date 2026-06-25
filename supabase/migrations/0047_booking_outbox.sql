-- #429 P2: durable intent log for the booking change-path. A row is written at
-- a mutation's atomic commit point; the dedicated /api/cron/outbox drain lane
-- resumes any row that isn't `delivered`, re-running only its not-`done` steps
-- idempotently. Server-only (RLS default-deny; written via supabaseAdmin).

create table booking_outbox (
  id          uuid primary key default gen_random_uuid(),
  -- nullable: the create path writes its reservation row before the booking row
  -- exists; on delete set null so a cancelled/purged booking can't orphan-block.
  booking_id  uuid references bookings(id) on delete set null,
  action      text not null check (action in ('create', 'cancel', 'reschedule', 'reassign')),
  status      text not null default 'pending' check (status in ('pending', 'delivered')),
  -- array of { name, state: pending|done|failed, error? } + any resume data the
  -- drain needs without re-reading mutable booking state.
  steps       jsonb not null default '[]'::jsonb,
  -- set while a drain (or the inline path) holds the row; null/past = reclaimable.
  lease_until timestamptz,
  attempts    int not null default 0,
  last_error  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Drain query: undelivered rows whose lease is free or expired, oldest first.
create index booking_outbox_drain_idx
  on booking_outbox (created_at)
  where status = 'pending';

alter table booking_outbox enable row level security;
