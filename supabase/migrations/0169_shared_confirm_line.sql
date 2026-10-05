-- #3325: the stored switch for the shared confirm line.
--
-- A crowd confirming one time used to wait in a separate line per isolate, so on a
-- burst the isolates' leaders contended at the database and every confirm ran out of
-- time with nobody booked (load run 37333201026). The shared line puts every confirm
-- for one time in ONE line across isolates, held by a Durable Object. It ships dark
-- behind this switch: off in production until the load run's burst passes, on in the
-- load test, and flipped on the admin Hours page beside the public booking pause, with
-- no deploy.
--
-- NOT NULL DEFAULT false, so a row that predates it, and a database where nobody ever
-- pressed the switch, confirm exactly as before (L72). Read by the confirm path through
-- a 15 second per isolate cache (src/lib/booking/shared-line-switch-core.ts), whose
-- failed reads are never cached as the answer: an isolate with no good read uses the
-- deployment default, SHARED_CONFIRM_LINE_DEFAULT.
--
-- Additive for the deployed code: one new column with a default, which nothing deployed
-- names. The settings row is written column scoped (an upsert on id naming only its own
-- columns), so no existing writer clobbers it.

alter table booking_settings
  add column shared_confirm_line boolean not null default false;

comment on column booking_settings.shared_confirm_line is
  'The #3325 shared confirm line. True puts every confirm for one time in one line shared by every isolate (a Durable Object), so a crowd gets one booking per free advisor and fast SLOT_TAKEN answers. Off by default; read by the confirm path through a 15 second per isolate cache.';
