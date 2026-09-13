-- #2274: two leads can confirm OVERLAPPING calls with one agent, and nothing
-- stops them.
--
-- Found by the first load run that ever confirmed bookings concurrently (#2261):
-- three pairs of confirmed bookings overlapping on one agent, for example
-- 17:50 to 18:10 against 18:00 to 18:20, each pair created about 200ms apart by
-- two different leads.
--
-- The appointment is 20 minutes long and offered on a 10 minute grid (measured on
-- production, `event_types.duration_min` 20 against `slot_interval_min` 10), so
-- every adjacent offered time OVERLAPS the one before it by ten minutes. The
-- guard from 0017 is `unique (assigned_user_id, starts_at)`: 17:50 and 18:00 are
-- two different starts, so it admits both and is doing exactly what it was
-- written to do. Verify-on-book is blind in the same window, because 200ms apart
-- neither confirm has the other's `busy_blocks` row yet, so the two checks fail
-- together rather than covering for each other.
--
-- An EXCLUDE constraint is the only thing here that can express "these two rows
-- OVERLAP", which a unique index cannot: uniqueness compares values, and overlap
-- is a relation between ranges. `btree_gist` is what lets one constraint mix an
-- equality on the agent with an overlap on the range.
--
-- It is deliberately scoped to EXACTLY the rows 0017 scopes to, and
-- `scripts/test-booking-overlap-guard.ts` compares the two filters against each
-- other rather than against a copy, so the day one changes the other fails rather
-- than quietly leaving a hole. `allow_double_book` is not decoration: the reassign
-- API books an advisor onto a lead they already own even when busy, and sets that
-- flag, so a guard ignoring it would refuse that feature outright.
--
-- The 0017 index is KEPT. It is subsumed in theory (two bookings at one start
-- always overlap, and no row has `ends_at <= starts_at`), but retiring a working
-- guard in the same change that adds a new one is two changes at once, and the
-- same-start race keeps its long-proven 23505 path.
--
-- APPLIED AGAINST ZERO ROWS. Measured immediately before applying: 2,179
-- bookings, every one `cancelled` or `completed`, so nothing is `confirmed` or
-- `rescheduled` with the flag false and the constraint validates an empty set.
-- That is only true before cutover; after it, this needs a scan and any existing
-- overlap would block it outright.
create extension if not exists btree_gist;

alter table bookings
  add constraint bookings_active_no_overlap
  exclude using gist (
    assigned_user_id with =,
    -- HALF OPEN on purpose. Back to back bookings are the normal case on a grid
    -- finer than the duration, and a closed range would refuse a booking that
    -- starts exactly when another ends, which breaks ordinary booking far more
    -- visibly than the defect this closes. It matches `[starts_at, ends_at)`, the
    -- same window the judge's own overlap predicate uses.
    tstzrange(starts_at, ends_at, '[)') with &&
  )
  where (status in ('confirmed', 'rescheduled') and allow_double_book = false);
