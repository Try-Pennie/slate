-- #2873: a booking source for each trypennie surface that moves to Slate with
-- #2870, so a booking from it records its page instead of `unrecognised`.
--
--   pennie              /pennie/[SO_ID]                 (review form)
--   review-terms        /review-terms/[SO_ID]           (terms form)
--   my-offers-result-2  /my-offers/result-2             (review form)
--   income-landing      the /portal-2 and /portal-3 calendar (Income Verification)
--
-- /offerportal and /offerportal-2 get no source of their own: their Income
-- Verification pop ups rewrite the page's source to `offerhub`, which is already in
-- the list. The vocabulary lives in code (PAGE_SOURCES, src/lib/booking/
-- booking-source.ts) and scripts/test-booking-source.ts holds this constraint equal
-- to it.
--
-- NOTHING IS BACKFILLED and no row is written, so updated_at does not move and the
-- Snowflake export cursor needs no rewind. Replacing a CHECK re-validates every row,
-- and every existing value is still in the list.

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
    'pennie',
    'review-terms',
    'my-offers-result-2',
    'income-landing',
    'not-given',
    'unrecognised',
    'api-regal',
    'api-trypennie',
    'api-canary'
  ));
