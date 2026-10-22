-- #4031: subscribe booking.contact_updated ("Slate Booking Contact Updated").
--
-- #1512 made Slate emit it when a lead corrects their phone number on the manage
-- page with no reschedule beside it, and shipped it INERT: no endpoint's `events`
-- array named it, so every emission reached nobody (#1459). Dan decided on
-- 2026-10-21 that a number a lead types on the manage page counts as consent, so the
-- event now names the corrected number primary AND subscribed for voice and SMS, and
-- he approved turning it on for the live Regal endpoint. The code half is in
-- src/lib/webhooks/regal.ts, and the DELIBERATELY_UNSUBSCRIBED entry is removed in
-- the same change.
--
-- Two writes, each blind where the other looks, as in 0135:
--
--   1. the column DEFAULT, what a NEW endpoint is created with, which
--      scripts/test-webhook-event-subscribers.ts compares the code's list against;
--   2. the live Regal endpoint row, which no default will ever reach, and which the
--      monitor lane's webhook_subscribers check reads. Scoped to that one row BY ID
--      (Dan approved this endpoint, not every endpoint), so a database without it
--      (a replay from empty, the local browser stack) updates nothing and says so.

alter table webhook_endpoints
  alter column events set default array[
    'booking.created', 'booking.rescheduled',
    'booking.cancelled', 'booking.reassigned',
    'agent.bookable_changed', 'booking.contact_updated'];

-- Idempotent by the `not (... = any ...)` filter: a second run appends nothing and
-- says it appended nothing, so "it worked" and "there was nothing to do" are
-- different answers (L98).
do $$
declare
  v_rows integer;
begin
  update webhook_endpoints
     set events = events || array['booking.contact_updated']
   where id = '0dacd170-d368-477b-96f7-f1f3d04f39e8'
     and not ('booking.contact_updated' = any (events));

  get diagnostics v_rows = row_count;

  raise notice '#4031: booking.contact_updated added to % live Regal webhook_endpoints row(s)', v_rows;
end;
$$;
