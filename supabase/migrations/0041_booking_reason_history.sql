-- #326 + #300 (ADR 0001): capture reschedule/cancel reasons and keep a durable,
-- append-only history of how a booking moved, preserving the ORIGINAL scheduled
-- time so show-rate can be measured against it.

-- 1. Preserve the original scheduled time on the booking (immutable after set).
--    createBooking sets these at insert; reschedule never touches them.
alter table bookings add column original_starts_at timestamptz;
alter table bookings add column original_ends_at   timestamptz;

-- Backfill existing rows. Only `confirmed` bookings are GUARANTEED never to have
-- been rescheduled (applyReschedule flips status to 'rescheduled' permanently),
-- so their current time IS the original. For 'rescheduled' rows the stored time
-- is the MOVED time, and 'completed'/'cancelled' rows may have been rescheduled
-- before reaching that state — for all of those the original is unrecoverable
-- (the history this feature adds didn't exist yet), so we leave it NULL rather
-- than record a wrong "original" and corrupt the metric. New bookings are exact.
update bookings
set original_starts_at = starts_at, original_ends_at = ends_at
where status = 'confirmed';

-- 2. Append-only history of reschedule/cancel/reassign events.
create table booking_events (
  id                 uuid primary key default gen_random_uuid(),
  booking_id         uuid not null references bookings(id) on delete cascade,
  -- What happened. 'reassigned' is the contact-owner override (same time, new
  -- agent); kept distinct so reschedule-rate reporting reads this column and is
  -- NOT inflated by reassignments (which still emit booking.rescheduled).
  action             text not null check (action in ('rescheduled', 'cancelled', 'reassigned')),
  -- Who drove it. 'system' = the machine reassign API; 'admin' = staff screen;
  -- 'customer' = the self-serve manage link.
  initiator          text not null check (initiator in ('customer', 'agent', 'admin', 'system')),
  -- Stable reason code (analytics dimension) + optional free text for "Other".
  reason_code        text not null,
  reason_detail      text,
  -- Reschedule: previous -> new time. Cancel: from = the cancelled time, to null.
  from_starts_at     timestamptz,
  to_starts_at       timestamptz,
  -- Agent change (reschedule/reassign may move the booking to a new advisor).
  from_agent_user_id uuid references users(id) on delete set null,
  to_agent_user_id   uuid references users(id) on delete set null,
  -- Signed minutes between the appointment's from-time and when the action
  -- happened: positive = lead time before the appointment, negative = after it.
  lead_time_minutes  integer,
  created_at         timestamptz not null default now()
);

create index booking_events_booking_id_idx on booking_events (booking_id);

-- Server-only (secret-key client); default-deny RLS keeps it unreachable by the
-- publishable client, like reschedule_locks / rate_limits.
alter table booking_events enable row level security;
