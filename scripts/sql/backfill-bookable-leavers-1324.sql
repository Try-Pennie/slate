-- #1324: clear `bookable` on agents who have already left.
--
-- Offboarding used to set `deactivated_at` alone, so a leaver kept
-- `users.bookable = true` indefinitely. The write is fixed (the flag is now
-- cleared in the same statement that deactivates), and this corrects the rows
-- that were left behind. Measured 2026-08-10: 13 rows carry the flag and 11 of
-- them are deactivated leavers, so the flag alone overstates the bookable pool
-- by 11 people who cannot take a booking.
--
-- Safe by construction:
--   * routing eligibility already requires `deactivated_at is null`, so none of
--     these rows can currently receive a booking and nothing about routing
--     changes;
--   * the WHERE clause touches ONLY deactivated rows, so the two active
--     `is_test` smoke agents (which must stay bookable, #396, or the six-hourly
--     canary stops proving the booking funnel) are untouched;
--   * `users` is not a Snowflake-mirrored table, so no `export_cursor` rewind is
--     needed (see the backfill rule in AGENTS.md).
--
-- Reactivation deliberately does not restore the flag: re-admitting somebody to
-- the routing pool is the decision `users.bookable` exists to make deliberately.

-- Expected: UPDATE 11.
update users
   set bookable = false
 where deactivated_at is not null
   and bookable = true;

-- Verify: expect 0 rows.
select id, email, deactivated_at
  from users
 where deactivated_at is not null
   and bookable = true;
