-- #429 P3 producer wiring: outbox rows need to carry the mutation's context
-- (cancel/reschedule reason, initiator, prior agent/time) so the drain can run
-- a step without re-reading mutable booking state that the mutation already
-- changed. Defaults to '{}' so existing/empty rows are unaffected.
alter table booking_outbox add column if not exists payload jsonb not null default '{}'::jsonb;
