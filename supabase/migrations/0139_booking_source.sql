-- #2072: record where a booking came from.
--
-- cal.com told a booking's origin apart by WHICH event type took it: seven routing
-- forms, each feeding its own event type, separated only for tracking. Slate books
-- every lead through one flow, so without this the consolidation itself would erase
-- the attribution. A landing page now puts `?source=<page>` on the booking link,
-- `/book` and `/booking/{id}` copy it into prefill with every other param, and
-- createBooking records it here after validating it on the server
-- (src/lib/booking/booking-source.ts, readBookingSource).
--
-- WHAT THE COLUMN HOLDS. One of a fixed vocabulary, enforced by the CHECK below and
-- held equal to BOOKING_SOURCES by scripts/test-booking-source.ts:
--
--   a page:        my-offers-result, booking, booking-agent-eligible, booking-portal,
--                  offerhub, rml-portal, email-booking, guided-app, agent-direct
--   not-given:     the link carried no source (older links, direct visits, the
--                  direct booking API). Recorded explicitly, never an empty string.
--   unrecognised:  the link named a page Slate does not know. Kept apart from
--                  not-given because it is a broken link somebody should fix. The
--                  raw value is logged (tag=booking-source) and stays in prefill,
--                  and is never written here, so the column only ever holds the
--                  vocabulary.
--
-- Each source maps onto its legacy cal.com event type name (review, connect, call,
-- income, terms, apply, meet) in code, SOURCE_DETAILS, so reporting can group by
-- either. The mapping is deliberately not stored: it is derived, and a stored copy
-- would drift from it.
--
-- NULL MEANS SOMETHING DIFFERENT FROM not-given. Every row that exists when this
-- runs predates the field, so nobody asked its link for a source, and null records
-- exactly that: "booked before sources were recorded". It is NOT backfilled to
-- not-given, which would claim those links were read and found empty. Nothing is
-- backfilled at all, so no existing row is written, updated_at does not move, and
-- the Snowflake export cursor needs no rewind.
--
-- No default, for the same reason: a default of not-given would stamp that claim on
-- any insert path that forgot to read the link, and hide the omission.
--
-- Adding a nullable column with no default is a catalog change, and validating the
-- CHECK passes on every existing (null) row.

alter table bookings
  add column source text;

alter table bookings
  add constraint bookings_source_check
  check (source in (
    'my-offers-result',
    'booking',
    'booking-agent-eligible',
    'booking-portal',
    'offerhub',
    'rml-portal',
    'email-booking',
    'guided-app',
    'agent-direct',
    'not-given',
    'unrecognised'
  ));

comment on column bookings.source is
  'The #2072 booking source: the page the lead booked from, or not-given (the link carried none) or unrecognised (it named an unknown page). Null for bookings made before sources were recorded. Validated by readBookingSource; the legacy cal.com event type is derived in code (SOURCE_DETAILS).';
