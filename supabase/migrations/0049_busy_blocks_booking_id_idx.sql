-- #429 P3: index busy_blocks(booking_id). delete-by-booking (move_busy_block in
-- 0048, deleteBusyBlocksForBooking) and the #428 reconcile sweep were full seq
-- scans over ~494K rows on the hot path. A normal (non-concurrent) build briefly
-- locks WRITES (~1-2s) but not reads — fine for a one-time apply on a rebuildable
-- cache table; CONCURRENTLY was not worth the out-of-band-apply complexity at
-- this row count (see #438 discussion).
create index if not exists busy_blocks_booking_id_idx on busy_blocks (booking_id);
