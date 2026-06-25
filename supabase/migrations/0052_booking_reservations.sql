-- #429 P4 (b+c): intent-first crash-safe create. A reservation is written as the
-- FIRST durable act of a booking — pinning the chosen agent + a retry-safe Google
-- client event id BEFORE the calendar event is created — so any resumer (a user
-- re-submit OR the drain) reuses the SAME agent + event (Google 409s the
-- duplicate) instead of orphaning or duplicating. The reservation is deleted on
-- successful delivery (ephemeral); the drain resumes any that crashed mid-create.
--
-- idempotency_key is UNIQUE: it is the concurrency arbiter. Two concurrent
-- same-key creates both INSERT; one wins, the loser reads the winner's row and
-- adopts its pin (agent + client id), so no second event is ever created.
-- Server-only (RLS default-deny; written via supabaseAdmin).

create table booking_reservations (
  id                 uuid primary key default gen_random_uuid(),
  idempotency_key    text not null unique,
  pinned_user_id     uuid not null references users(id),
  pinned_agent_email text not null,
  gcal_client_id     text not null,
  -- everything insertBooking needs to complete the booking on a resume, without
  -- re-running the non-deterministic assignAgent (bucket/event-type ids, attendee,
  -- times, manage_token, routing_trace, prefill, etc.).
  payload            jsonb not null,
  status             text not null default 'pending' check (status in ('pending', 'delivered')),
  lease_until        timestamptz,
  attempts           int not null default 0,
  last_error         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Drain query: pending reservations whose lease is free/expired, oldest first.
create index booking_reservations_drain_idx
  on booking_reservations (created_at)
  where status = 'pending';

alter table booking_reservations enable row level security;
