-- Drain retry backoff (#445). The booking-outbox drain (processBookingOutbox) and
-- the create-reservation drain (processBookingReservations) re-attempt a failing
-- row every cron tick with no backoff: the `attempts`/`last_error` columns exist
-- but nothing increments or reads them, so a permanently-failing step is retried
-- endlessly and silently (and hits Google / the Regal webhook every minute).
--
-- Add `next_attempt_at`: a row is only drainable once its scheduled retry time has
-- passed (NULL = never failed = drain now). The drain stamps it on each failure
-- via an exponential schedule (drain-backoff.ts), increments `attempts`, records
-- `last_error`, alerts past a threshold, and stops loading the row past a give-up
-- cap (left pending + diagnosable). Both tables get the column symmetrically.

alter table booking_outbox add column next_attempt_at timestamptz;
alter table booking_reservations add column next_attempt_at timestamptz;
