-- #3615: record that an admin moved a rerouted call BACK to its original advisor.
--
-- A demotion sweep (0178) moves a call off an advisor Twilio demoted off the pool it needs. The
-- move is automatic, and was settled with Dan (2026-10-11) as automatic but undoable: an admin
-- can move the call back from the booking's page. Recording the undo on the item the sweep wrote
-- does three things:
--  - the booking page says "moved back by X on <date>" instead of offering the button again;
--  - later demotion sweeps, the demotion decision and the demoted-agent backstop leave that call
--    with the original advisor (Dan, 2026-10-11: the admin's choice stands, rather than the next
--    sync moving it again and the backstop paging about it every day);
--  - the write is a compare-and-swap on `reverted_at is null`, so two admins pressing at once
--    record one undo between them.
--
-- `reverted_by` is SET NULL on a user delete, like the other history columns that name a person
-- (booking_events.actor_user_id); the lifecycle deactivates rather than deletes, so in practice it
-- keeps its value. Additive only, so the code already deployed keeps working against it.
alter table bulk_reassign_items
  add column reverted_at timestamptz,
  add column reverted_by uuid references users(id) on delete set null;

comment on column bulk_reassign_items.reverted_at is
  'When an admin moved this call back to the sweep''s original advisor (#3615). NULL until then. A reverted demotion move is left with that advisor by later demotion sweeps and by the demoted-agent backstop.';
comment on column bulk_reassign_items.reverted_by is
  'The admin who moved the call back (#3615). NULL until then.';
