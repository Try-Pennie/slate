-- #2368: subscribe the new booking.reassigned webhook event.
--
-- A reassign moves a booking to another advisor and never moves the time, so until
-- now it reached Regal as `Slate Booking Rescheduled` and every journey listening
-- for a time change fired on one that had not happened. The code half of that is in
-- src/lib/webhooks (a new WebhookEvent, a new Regal event name); this is the other
-- half, and neither works without it.
--
-- `emitWebhook` delivers only to endpoints whose stored `events` array CONTAINS the
-- event, and zero matches is not an error: the map over an empty endpoint list
-- resolves, the outbox step is marked done, and the event is gone with no failure,
-- no alert and no delivery row (#1459, L120). So there are two writes here, and each
-- is blind where the other looks:
--
--   1. the column DEFAULT, which is what a NEW endpoint is created with, and which
--      scripts/test-webhook-event-subscribers.ts compares the code's event list
--      against at build time;
--   2. the rows that ALREADY exist, which no default will ever reach. The one live
--      Regal endpoint predates every event added from here on, and the monitor
--      lane's webhook_subscribers check is what reads those rows.
--
-- ORDER, and it matters more than usual (#2308): applying this is what starts the
-- event reaching Regal. It must not be applied until the Regal "Slate Booking
-- Reassigned" journey exists, or a real reassign will arrive somewhere with nothing
-- listening for it.

alter table webhook_endpoints
  alter column events set default array[
    'booking.created', 'booking.rescheduled',
    'booking.cancelled', 'booking.reassigned', 'booking.completed'];

-- Append it to the endpoints that already exist. Idempotent by the `not (... = any
-- ...)` filter rather than by rerunning blind: a second run appends nothing and says
-- it appended nothing, so "it worked" and "there was nothing to do" are different
-- answers rather than the same silence (L98).
do $$
declare
  v_rows integer;
begin
  update webhook_endpoints
     set events = events || array['booking.reassigned']
   where not ('booking.reassigned' = any (events));

  get diagnostics v_rows = row_count;

  raise notice '#2368: booking.reassigned added to % existing webhook_endpoints row(s)', v_rows;
end;
$$;
