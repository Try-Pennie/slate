-- #3543: a booking source for Marcia's booking MCP endpoint.
--
-- A booking made through `McpBookingGateway` records `mcp-marcia` rather than
-- `not-given`, which the per page volume alarm would read as a booking any landing
-- page could have sent (the reason #2876 gave each API caller its own source). The
-- vocabulary lives in code (MCP_SOURCES, src/lib/booking/booking-source.ts) and
-- scripts/test-booking-source.ts holds this constraint equal to it.
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
    'api-canary',
    'mcp-marcia'
  ));
