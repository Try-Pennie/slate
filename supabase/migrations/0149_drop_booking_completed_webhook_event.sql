-- #2915: stop sending booking.completed ("Slate Booking Completed") to Regal.
--
-- Completion is decided on the clock, once a call's end time has passed, not on
-- evidence the call happened, so the event fired for no-shows too (11ba4b91 and
-- 0cc2fbac on 2026-09-29 were dispositioned 1.1A no-show in Regal and still got
-- Completed). Regal knows whether a call happened from its own call and disposition
-- data. Before removing it, every Regal journey was read for a use of the event
-- (recorded on #2915); none triggers on it or checks it.
--
-- The code half removes the event from WebhookEvent, so the completion sweep sends
-- nothing. This half removes it from the two places a subscription lives, the
-- reverse of 0135: the column DEFAULT (what a NEW endpoint is created with, which
-- scripts/test-webhook-event-subscribers.ts compares the code's list against) and the
-- rows that ALREADY exist (which the monitor lane's webhook_subscribers check reads).
--
-- Delivery rows already written keep their event name as history. The send paths
-- refuse to POST one again (isEmittedEvent, src/lib/webhooks/events.ts).

alter table webhook_endpoints
  alter column events set default array[
    'booking.created', 'booking.rescheduled',
    'booking.cancelled', 'booking.reassigned',
    'agent.bookable_changed'];

-- Idempotent by the `= any` filter: a second run removes nothing and says so, so
-- "it worked" and "there was nothing to do" are different answers (L98).
do $$
declare
  v_rows integer;
begin
  update webhook_endpoints
     set events = array_remove(events, 'booking.completed')
   where 'booking.completed' = any (events);

  get diagnostics v_rows = row_count;

  raise notice '#2915: booking.completed removed from % existing webhook_endpoints row(s)', v_rows;
end;
$$;
