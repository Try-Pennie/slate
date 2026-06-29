-- Foreign key on busy_blocks.booking_id -> bookings(id) (#432). The column was a
-- bare uuid (0001_init.sql:127), which is precisely how orphaned slot rows (a
-- busy_block pointing at a booking that no longer exists) could form - the class
-- of rows #428's reconcile sweep has to clean up at runtime. The FK prevents that
-- class structurally and documents the relationship for the hand-written DB types.
--
-- ON DELETE CASCADE matches user_id in this same table (0001_init.sql:126) and is
-- the correct semantic: a busy_block exists only to mark a slot busy FOR a
-- booking, so if the booking row is deleted the slot must free. gcal mirror rows
-- keep booking_id NULL (an FK permits NULL), so they are unaffected. Normal cancel
-- is a soft status change that already deletes the block explicitly, so CASCADE
-- only fires on an actual booking-row DELETE (e.g. test teardown / data purge),
-- where freeing the slot is exactly what we want.
--
-- Safe to add directly with immediate validation: prod has 0 orphans and only a
-- handful of non-null booking_id rows (the ~500k rest are gcal mirrors with NULL),
-- so the validating scan is trivial and the brief lock is acceptable - same
-- posture as the #444 busy_blocks(booking_id) index (skip CONCURRENTLY / NOT VALID
-- out-of-band complexity when a normal build is a sub-second lock).

alter table busy_blocks
  add constraint busy_blocks_booking_id_fkey
  foreign key (booking_id) references bookings(id) on delete cascade;
