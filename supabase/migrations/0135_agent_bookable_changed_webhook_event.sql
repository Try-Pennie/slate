-- #2085: subscribe the new agent.bookable_changed webhook event.
--
-- When whether Slate can route a lead to an agent changes (made bookable, made
-- unbookable, offboarded), Slate now tells Regal with a traits only body,
-- {"userId": <agent email>, "traits": {"slateBookable": <bool>}}, POSTed to the
-- same endpoint the booking events go to. The code half is in src/lib/webhooks and
-- src/lib/bookable/routable-write.ts; this is the other half, and neither works
-- without it.
--
-- `emitWebhook` delivers only to endpoints whose stored `events` array CONTAINS the
-- event, and zero matches is not an error: the delivery is never recorded, nothing
-- fails and nothing alerts (#1459, L120). So there are two writes here, each blind
-- where the other looks:
--
--   1. the column DEFAULT, which is what a NEW endpoint is created with, and which
--      scripts/test-webhook-event-subscribers.ts compares the code's event list
--      against at build time;
--   2. the rows that ALREADY exist, which no default will ever reach. The one live
--      Regal endpoint predates this event, and the monitor lane's
--      webhook_subscribers check is what reads those rows.
--
-- ORDER: applying this is what starts the trait reaching Regal. Dan confirmed the
-- traits only body for this endpoint on 2026-09-08, so there is no journey to wait
-- for. Run `pnpm backfill:bookable-trait` AFTER this is applied, to give Regal every
-- agent's starting value; before it, the backfill refuses because nothing subscribes.

alter table webhook_endpoints
  alter column events set default array[
    'booking.created', 'booking.rescheduled',
    'booking.cancelled', 'booking.reassigned', 'booking.completed',
    'agent.bookable_changed'];

-- Append it to the endpoints that already exist. Idempotent by the `not (... = any
-- ...)` filter rather than by rerunning blind: a second run appends nothing and says
-- it appended nothing, so "it worked" and "there was nothing to do" are different
-- answers rather than the same silence (L98).
do $$
declare
  v_rows integer;
begin
  update webhook_endpoints
     set events = events || array['agent.bookable_changed']
   where not ('agent.bookable_changed' = any (events));

  get diagnostics v_rows = row_count;

  raise notice '#2085: agent.bookable_changed added to % existing webhook_endpoints row(s)', v_rows;
end;
$$;
