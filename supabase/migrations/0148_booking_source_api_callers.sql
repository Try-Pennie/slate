-- #2876: a booking made through the booking API records WHO called.
--
-- Until now a direct booking API call that sent no `prefill.source` recorded
-- `not-given`, the same value as a landing page link carrying no `?source=`. The
-- per page low volume alarm (#2738) reads `not-given` as a booking that could be
-- ANY page's, so it counts it into the pool that excuses a quiet page as
-- "source not recorded" instead of paging, and `bookingSourcesRecorded` refuses to
-- show the page floors as coverage while any exist. Once Regal's AI agent or
-- trypennie books real leads through the API, a steady stream of those would hide
-- a landing page gone dark.
--
-- The authenticated caller is known at that point (the key it matched, #2645), so
-- such a call now records `api-<caller>`: one value per caller in
-- BOOKING_API_CALLERS (src/lib/booking/api-callers.ts), derived from that list in
-- code (src/lib/booking/booking-source.ts, API_SOURCES). A page the caller DOES
-- name is still recorded as that page. scripts/test-booking-source.ts holds this
-- constraint equal to BOOKING_SOURCES, so a caller added in code without a
-- migration widening this list fails the build.
--
-- NOTHING IS BACKFILLED. Existing `not-given` rows made through the API cannot be
-- told apart from a link that carried nothing (the caller was never stored), so
-- rewriting them would be a guess recorded as a fact. No row is written, so
-- updated_at does not move and the Snowflake export cursor needs no rewind.
--
-- Replacing a CHECK re-validates every row, and every existing value is still in
-- the list, so it passes on the rows already there.

alter table bookings
  drop constraint bookings_source_check;

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
    'unrecognised',
    'api-regal',
    'api-trypennie',
    'api-canary'
  ));

comment on column bookings.source is
  'The #2072 booking source: the page the lead booked from, or not-given (the link carried none) or unrecognised (it named an unknown page), or api-<caller> (#2876: a booking API call that named no page, by the caller whose key it used). Null for bookings made before sources were recorded. Validated by readBookingSource; the legacy cal.com event type is derived in code (SOURCE_DETAILS).';
