-- #518: crash-safe standalone reassign. reassignBooking creates the new Google
-- event BEFORE the atomic swap; a crash in that window orphaned the event with
-- nothing durable to clean it, and silently dropped the reassign. A reassign_intent
-- is written as the FIRST durable act (before createEvent), pinning the target
-- agent + the deterministic new-event id; after the swap it also records the
-- REPLACED old event; it is deleted once create+swap+delete-old complete.
-- processAbandonedReassignIntents (on the /api/cron/outbox lane) cleans any intent
-- whose lease expired: it deletes whichever recorded event is NOT the booking's
-- live one, and alerts when a reassign was genuinely lost (fail-loud, since the
-- machine contact-owner override caller has no human retry loop).
--
-- unique(booking_id, gcal_client_id): a same-target retry recomputes the IDENTICAL
-- deterministic id, so writeReassignIntent upserts (refreshes the lease) instead of
-- failing, preserving #449's idempotent-retry behavior. This is NOT a per-booking
-- mutex (reschedule_locks is): standalone reassign is deliberately lock-free /
-- last-write-wins (#449, 0058), so two concurrent distinct-target reassigns each
-- get their own row and neither is rejected. Server-only (RLS default-deny; written
-- via supabaseAdmin).

create table reassign_intents (
  id                 uuid primary key default gen_random_uuid(),
  booking_id         uuid not null references bookings(id) on delete cascade,
  pinned_agent_email text not null,          -- target agent; the NEW event lives here
  gcal_client_id     text not null,          -- the NEW event (created before the swap)
  prev_agent_email   text,                    -- filled AFTER the swap: the replaced agent
  prev_gcal_event_id text,                    -- filled AFTER the swap: the replaced event
  lease_until        timestamptz not null,
  created_at         timestamptz not null default now(),
  unique (booking_id, gcal_client_id)
);

-- Sweep query: intents whose lease is past, oldest first.
create index reassign_intents_sweep_idx on reassign_intents (lease_until);

alter table reassign_intents enable row level security;
