-- #2728: record the origin of the page that framed the booker.
--
-- The off site booking page (#2715) judges `prefill.parentOrigin`, which is what a
-- host DECLARES. widget.js always declares its own page, so a booking carrying no
-- declared origin came from a host that framed /book itself, which is exactly the
-- test page the check exists to notice: 9 real bucket bookings in 60 days carried
-- none. The browser still says who framed the booker (`document.referrer`), so the
-- booker now sends that ORIGIN with the confirm, and createBooking stores it here
-- after reducing it to an origin again on the server
-- (src/lib/embed/referrer-origin.ts, readReferrerOrigin).
--
-- WHAT THE COLUMN HOLDS. A bare web origin (scheme, host, optional port), never a
-- path or a query, which on a booking page can carry a lead's details. The CHECK
-- below refuses anything else, so a value the code failed to reduce is refused at
-- the database rather than stored. scripts/test-referrer-origin.ts holds this
-- pattern and the length ceiling against what the server can produce, so the
-- constraint can never refuse a booking the code would have made.
--
-- NULL is every booking that carries no framing page: the standalone /book page
-- (its referrer is whatever linked to it, not a host page, and is not sent), the
-- direct booking API, an admin booking, a host whose referrer policy strips the
-- referrer, and every booking made before this column existed. Nothing is
-- backfilled, so no existing row is written, updated_at does not move, and the
-- Snowflake export cursor needs no rewind. No default, for the same reason as
-- 0139: a default would claim a reading nobody took.
--
-- Not mirrored to Snowflake in this change: the export writes every column it
-- names on every MERGE, so adding it there needs the warehouse ALTER run first.
--
-- Adding a nullable column with no default is a catalog change, and validating the
-- CHECK passes on every existing (null) row.

alter table bookings
  add column referrer_origin text;

alter table bookings
  add constraint bookings_referrer_origin_check
  check (
    referrer_origin ~ '^https?://[^/?#[:space:]]+$'
    and char_length(referrer_origin) <= 2048
  );

comment on column bookings.referrer_origin is
  'The #2728 framing page: the origin (never the path) of the page that framed the booker, from document.referrer, re-reduced on the server by readReferrerOrigin. Null when the booker was not framed, the referrer was stripped, or the booking predates the column. Judged beside prefill.parentOrigin by the off site check (src/lib/monitor/offsite-origin.ts).';
