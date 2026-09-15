-- #2297: a kill switch that stops Slate taking public bookings without a deploy.
--
-- Before this, the only lever was flipping `bookable` across the roster, which also
-- stops availability computing and so destroys the signal you would want while
-- working out what is wrong. This closes the public booking WRITE and nothing else:
-- availability, the slot cache, Google sync, the key-authed API, reschedule and
-- cancel all keep running, deliberately (the reasoning is in
-- src/lib/booking/kill-switch.ts).
--
-- It lives on the existing single-row booking_settings config (0086, #1015) rather
-- than a new table, for the same reason horizon_days did in 0087: that row is
-- already the per-request booking-config row, and the booking path already reads it.
--
-- NOT NULL DEFAULT false, unlike its nullable neighbours on this table. A null here
-- would have to mean something, and both readings are wrong: read as paused it holds
-- every booking the moment this migration lands, and read as open it is a third state
-- the gate has to carry for no benefit. The column's default is its OFF value, so a
-- row that predates it takes bookings exactly as before (L72).
--
-- The value is read PER REQUEST and never cached: the whole point is that it takes
-- effect in seconds, and any TTL is the delay somebody is staring at while a booking
-- they wanted to stop goes through.
alter table booking_settings
  add column public_booking_paused boolean not null default false;

comment on column booking_settings.public_booking_paused is
  'The #2297 kill switch. True refuses the embed booking write; availability, sync, the key-authed API, reschedule and cancel are unaffected. Read per request, never cached.';
