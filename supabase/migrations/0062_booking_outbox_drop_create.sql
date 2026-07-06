-- #667: drop the retired 'create' value from booking_outbox.action. No producer
-- ever enqueues a create outbox row (the create path uses booking_reservations
-- as its durable intent, #613), and the drain dispatches on step name, not
-- action, so action is descriptive metadata only. The dead value invited future
-- confusion (an assumed create-outbox drain). Verified 0 live rows use 'create'
-- before shipping, so the tightened CHECK validates cleanly against existing data.
--
-- 0047 created the constraint inline on the column, so Postgres auto-named it
-- booking_outbox_action_check (table_column_check). Drop and re-add it named.
alter table booking_outbox drop constraint booking_outbox_action_check;
alter table booking_outbox add constraint booking_outbox_action_check
  check (action in ('cancel', 'reschedule', 'reassign'));
