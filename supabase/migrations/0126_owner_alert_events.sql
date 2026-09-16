-- #2371: Slate's record of the advisor only "previously pitched" alert it wrote onto an
-- owning advisor's calendar.
--
-- The Pipedream flow this replaces created a 20 minute event titled
-- `ALERT - Previously Pitched - Call with {lead_email}` and recorded it nowhere Slate
-- could read, so nothing could ever take it back off the calendar when the call was
-- cancelled, moved, or handed to somebody else. This table is what makes every one of
-- those exits possible: the row is written BEFORE the Google event and holds the id
-- afterwards, so a crash in between leaves a row pointing at nothing (recoverable, the
-- outbox step retries) rather than an event nothing points at (an orphan on a real
-- advisor's calendar, findable by nobody).
--
-- NO LEAD DATA, BY DESIGN. The row names a booking, an advisor, a calendar and a Google
-- event id, and the event itself carries no lead name, address or number either (see
-- src/lib/booking/owner-alert.ts). That is what keeps this table OUT of the erasure
-- function (migration 0092) and out of the Snowflake mirror, exactly like
-- `reassign_intents` and `booking_handoffs`: an erasure that redacts the booking leaves
-- nothing personal behind here, so there is nothing to miss. Do not add a lead column.
--
-- ON DELETE CASCADE on both keys, matching `reassign_intents`. Bookings are redacted in
-- place and never deleted by retention, so the only deletes are fixture cleanups, and a
-- record of an alert whose booking or advisor no longer exists describes nothing.
--
-- `calendar_id` holds the advisor's own calendar ADDRESS rather than the literal
-- "primary". A Google account's primary calendar id IS its address, and the removal
-- paths need to know both which calendar to delete from and whose identity to do it
-- with; one column that answers both is one fewer thing to keep in step than a
-- `calendar_email` beside a constant.
create table owner_alert_events (
  id            uuid primary key default gen_random_uuid(),
  booking_id    uuid not null references bookings(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  -- Null between the row being written and Google answering, and null forever on a
  -- row whose calendar write was definitively refused (see skip_reason).
  gcal_event_id text,
  calendar_id   text not null,
  created_at    timestamptz not null default now(),
  -- Set when the alert has been taken back off the calendar (the call was cancelled,
  -- or handed to a different advisor). A live alert is one with a null here.
  removed_at    timestamptz,
  -- Why Google was not touched, when it was not: a `gone` or `not-provisioned`
  -- calendar (see src/lib/google/sync-health.ts). Recorded rather than retried,
  -- because no amount of retrying fixes either, and recorded rather than left blank,
  -- because "no event" and "no event and here is why" read identically otherwise.
  skip_reason   text
);

-- The live alert for a booking, and the guarantee that there is only ever one. Every
-- lifecycle step asks exactly this question ("what is this booking's live alert"), so
-- the partial index both serves the read and enforces the singleton. PARTIAL on
-- purpose: a booking legitimately accumulates removed rows as it is reassigned from
-- advisor to advisor, and that history is worth keeping.
create unique index owner_alert_events_one_live_per_booking
  on owner_alert_events (booking_id)
  where removed_at is null;

-- Server reads and writes through the secret key client only; no client access.
alter table owner_alert_events enable row level security;

comment on table owner_alert_events is
  'The #2371 advisor only "previously pitched" calendar alert: one live row per booking while an owning advisor holds it. Carries no lead data, so it sits outside the erasure function and the Snowflake mirror.';
