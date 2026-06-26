-- Persisted, queryable routing decisions (including no-booking attempts).
-- Answers "why did this booking go to this agent" and "why did this lead get
-- no slots". The per-booking bookings.routing_trace column holds the same data
-- for booked rows; this table additionally captures attempts that never booked.

create table routing_decisions (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null,
  booking_id          uuid references bookings(id) on delete set null,
  bucket_code         text not null,
  bucket_id           uuid,
  requested_tier      text,
  booked_tier         text,
  chosen_user_id      uuid,
  considered          jsonb not null default '[]'::jsonb,
  excluded            jsonb not null default '[]'::jsonb,
  empty_pool_fallback boolean not null default false,
  tier_fallback       boolean not null default false,
  rungs_dropped       int not null default 0,
  outcome             text not null
                        check (outcome in ('booked','no_availability','no_eligible_agents','error')),
  created_at          timestamptz not null default now()
);

create index routing_decisions_created_idx on routing_decisions (created_at);
create index routing_decisions_booking_idx on routing_decisions (booking_id);

-- Server reads/writes via the secret-key admin client; no client access.
alter table routing_decisions enable row level security;
