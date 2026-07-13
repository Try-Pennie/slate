-- #758: tell an ADOPTED-THEN-SUPERSEDED reassign apart from one that was never
-- adopted, so the sweep's "a reassign was silently lost" alert can be trusted.
--
-- The sweep calls an intent `dropped` when its NEW event is not the booking's live
-- event. That reads a chained crash wrong: reassign #1 commits its swap, crashes
-- before deleting its intent, and reassign #2 then moves the booking on to a third
-- agent. Intent #1's event is no longer live, so it was reported as a lost reassign
-- that must be re-run. It was not lost. It succeeded, and was superseded.
--
-- prev_gcal_event_id cannot stand in for "the swap committed": a booking with no
-- prior calendar event records it as NULL even on a perfectly committed swap. So
-- record the fact itself. Written only after `reassignSwap` reports updated=true
-- (orchestration.ts, recordReassignIntentPrev), which is exactly the post-swap point.
--
-- Nullable with no backfill on purpose: an in-flight intent written by the OLD code
-- has no swapped_at, and NULL keeps the pre-#758 reading (count it dropped). That is
-- the safe direction, since it over-reports rather than silencing a real loss, and
-- any such row is swept within minutes of deploy.
alter table reassign_intents
  add column if not exists swapped_at timestamptz;

comment on column reassign_intents.swapped_at is
  'Set when the reassign swap COMMITTED (#758). NULL = the new event was never adopted, so an abandoned intent is a genuinely-lost reassign worth alerting on.';
