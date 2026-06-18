-- Idempotency for token reschedules. A double-clicked reschedule fires two
-- rescheduleBooking calls; without a guard the second re-reads the (already
-- moved) booking and redoes the Google delete/recreate and re-emits
-- booking.rescheduled. One row per in-flight (booking, target instant); the
-- composite PK lets exactly one concurrent caller win, and the loser treats it
-- as a no-op. The winner deletes its row when done; a row orphaned by a
-- torn-down Worker is reclaimed once it ages past the staleness window.
create table reschedule_locks (
  booking_id       uuid not null references bookings(id) on delete cascade,
  target_starts_at timestamptz not null,
  claimed_at       timestamptz not null default now(),
  primary key (booking_id, target_starts_at)
);

-- Server-only (secret-key client); default-deny RLS keeps it unreachable by
-- the publishable client, like sync_locks / rate_limits.
alter table reschedule_locks enable row level security;
