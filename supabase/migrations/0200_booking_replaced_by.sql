-- #3672: a booking the API moved to another bucket records the booking that replaced it.
--
-- WHAT WAS WRONG. A booking API call naming a different bucket than the lead's existing
-- call (#364 at a new time, #1465 at the same one) is honoured by creating a NEW booking,
-- with a new id and a new manage token, and cancelling the old one (reason
-- `api_rebooking`). Every copy of the old token already handed out (the manage link in the
-- webhook Regal texts the lead from, the calendar file, a rebook link) still named the
-- cancelled row, so the manage page told a lead who still had a call that it was
-- cancelled. Nothing linked the two rows.
--
-- THE RULE (Dan, 2026-10-23). The old links follow to the booking that replaced it. The
-- cancel of the old row writes this column in the SAME statement that flips its status
-- (`claimCancellation`), so a crash can never leave a cancelled row without its successor
-- or a successor recorded on a row that was never cancelled. The manage page, the
-- calendar file and the rebook route follow it to the end of the chain, bounded, and
-- refuse a cycle (`getBookingByToken` in src/lib/booking/orchestration.ts).
--
-- Null on every other booking, including one cancelled any other way: that lead's link
-- still says cancelled, because for them it is.
--
-- SAFE FOR THE CODE ALREADY DEPLOYED. One new nullable column, a check and an index;
-- nothing the deployed code names changes, so it runs unchanged between `db push` and the
-- deploy (docs/migrations-runbook.md, "Deployed code must keep working").
--
-- NOT LEAD DATA. It is another booking's id, so it needs no entry in the erasure function
-- (migration 0092). It is not mirrored to Snowflake (UNMIRRORED_COLUMNS records what a
-- restore does without it).
--
-- ON DELETE SET NULL. A booking row is not deleted in the normal course, but if a
-- successor ever were, the old row falls back to an ordinary cancelled booking rather than
-- refusing the delete or pointing at nothing.
alter table bookings
  add column if not exists replaced_by_booking_id uuid
    references bookings(id) on delete set null;

-- A booking cannot replace itself; that would be a one row cycle the follower refuses on
-- every read, so it is refused at the write instead.
alter table bookings
  add constraint bookings_replaced_by_not_self
    check (replaced_by_booking_id is null or replaced_by_booking_id <> id);

-- The foreign key's own lookup: deleting a booking asks which rows name it. Partial,
-- because almost every row names nothing and an entry for each would be dead weight.
create index if not exists bookings_replaced_by_booking_id_idx
  on bookings (replaced_by_booking_id)
  where replaced_by_booking_id is not null;

comment on column bookings.replaced_by_booking_id is
  'The booking that replaced this one when the booking API moved the call to another bucket (#3672). Written in the same statement that cancels this row. The manage page, calendar file and rebook route follow it so the lead''s old links open the call they still have. Null on every other booking.';
