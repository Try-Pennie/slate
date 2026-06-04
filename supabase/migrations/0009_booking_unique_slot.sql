-- Last-resort guard against the verify-on-book race: two concurrent bookings
-- can both find the same agent free and both insert for the same exact slot.
-- A partial unique index on ACTIVE bookings makes the second insert fail with
-- 23505, which the booking service turns into SlotUnavailableError so the race
-- loser is cleanly told to pick another time. Cancelled/completed rows are
-- excluded so they never block a fresh booking of the same slot.
create unique index if not exists bookings_active_slot_uniq
  on bookings (assigned_user_id, starts_at)
  where status in ('confirmed', 'rescheduled');
