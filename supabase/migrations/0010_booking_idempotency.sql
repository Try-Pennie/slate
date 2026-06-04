-- Idempotency guard for booking submission: a double-clicked/retried submit
-- must return the existing booking, not create a second one (with a second
-- Google event). The booking service derives a key from bucket + slot +
-- attendee identity and stores it here. Partial unique index over ACTIVE
-- bookings only — so a cancel-then-rebook of the same slot still works, and a
-- racing duplicate insert fails (23505) and is resolved to the winner.
alter table bookings add column idempotency_key text;

create unique index if not exists bookings_idempotency_active_uniq
  on bookings (idempotency_key)
  where idempotency_key is not null and status in ('confirmed', 'rescheduled');
