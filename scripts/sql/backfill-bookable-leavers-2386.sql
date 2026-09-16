-- #2386: clear `bookable` on the leavers the SALESFORCE REAP left behind.
--
-- The second half of #1324, on the path #1324 did not touch. That backfill
-- (scripts/sql/backfill-bookable-leavers-1324.sql, 2026-08-10) corrected the rows
-- the offboarding service had left, and its header says "the write is fixed". It
-- was, for that service. The hourly roster sync kept its own
-- `update users set deactivated_at = now() where id in (...)`, so every agent
-- Salesforce departed from 2026-08-10 onwards was stamped and left carrying the
-- flag. That write is fixed now too (both paths share
-- `src/lib/offboarding/lifecycle-write.ts`, and a repo guard fails the build on a
-- third copy), and this corrects what it left.
--
-- TWO harms, and the second is why this is not only tidying:
--   * every COUNT of the bookable pool overstates it by one per leaver;
--   * a rehire REACTIVATED later re-enters the routing pool the instant the admin
--     presses the button, because the calendar reachability probe and the pool
--     entry bootstrap live only on the `bookable` FLIP, which for these rows never
--     happened. The booker would offer their whole day against an empty cache.
--     The shipped reactivation now clears the flag as it returns them, so this
--     backfill is not the only guard on that; it is what makes the COUNTS right
--     today, for rows nobody is going to reactivate.
--
-- Safe by construction:
--   * routing eligibility already requires `deactivated_at is null`, so none of
--     these rows can currently receive a booking and nothing about routing changes;
--   * the WHERE clause touches ONLY deactivated rows, so the two active `is_test`
--     smoke agents (which must stay bookable, #396, or the six-hourly canary stops
--     proving the booking funnel) are untouched;
--   * `users` is not one of the Snowflake-mirrored tables (MIRROR_TABLES in
--     src/lib/snowflake/export-core.ts holds bookings, webhook_deliveries,
--     booking_outbox, booking_events, audit_log and routing_decisions), so NO
--     `export_cursor` rewind is needed. See the backfill rule in AGENTS.md.
-- export-cursor-ok: users is not a mirrored table, so no watermark is written and
-- nothing can land behind the export cursor.
--
-- Run the REPORT first and read the number. The 2026-08-10 measurement is stale by
-- five weeks of hourly reaps, and a backfill whose size is assumed rather than
-- measured cannot tell "it corrected what was there" from "it corrected more than
-- anybody expected".

-- ------------------------------------------------------------------ 1. REPORT --
-- Writes nothing. How many rows carry the defect, and how far back they go.
select count(*)                 as rows_to_correct,
       min(deactivated_at)      as earliest_departure,
       max(deactivated_at)      as latest_departure,
       count(*) filter (where deactivated_at >= timestamptz '2026-08-10')
                                as departed_since_the_1324_backfill
  from users
 where deactivated_at is not null
   and bookable = true;

-- Who they are, so the count can be checked against people rather than taken on
-- trust. Slate ids only: a report pasted into a transcript must not become a
-- roster export (L222).
select id, deactivated_at, is_test
  from users
 where deactivated_at is not null
   and bookable = true
 order by deactivated_at;

-- ------------------------------------------------------------------ 2. CORRECT --
-- Expected: the `rows_to_correct` the report above printed.
update users
   set bookable = false
 where deactivated_at is not null
   and bookable = true;

-- ------------------------------------------------------------------- 3. VERIFY --
-- Expect 0 rows.
select id, deactivated_at
  from users
 where deactivated_at is not null
   and bookable = true;
