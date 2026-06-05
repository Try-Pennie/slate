-- The agent-reassign API (#9) intentionally double-books an advisor onto a lead
-- they already own, even if they're busy. Double-booking must be allowed ONLY
-- through that path: an `allow_double_book` flag the endpoint sets, and the
-- active-slot unique index (migration 0009) is rebuilt to ignore flagged rows.
-- Everything else (createBooking, concurrent races) stays guarded as before.
alter table bookings add column if not exists allow_double_book boolean not null default false;

drop index if exists bookings_active_slot_uniq;
create unique index bookings_active_slot_uniq
  on bookings (assigned_user_id, starts_at)
  where status in ('confirmed', 'rescheduled') and allow_double_book = false;
