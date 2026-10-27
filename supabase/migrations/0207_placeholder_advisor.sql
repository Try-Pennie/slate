-- #4200: the data model for any time bookings placed by a person on a placeholder advisor.
--
-- A scheduling coordinator on the phone books whatever time the customer names. A free
-- advisor in the customer's bucket takes it when there is one, as a normal routed
-- booking; when nobody is free it goes on ONE placeholder advisor (Marcia, Pennie's AI
-- agent), stacked with any number of others at that time, and Regal redistributes the
-- call when it is due. Plan: https://claude.ai/artifact/XbByMLoaMrBufMr6Chmct1
--
-- 1. users.is_placeholder: the explicit marker. One real and one test placeholder per org
--    (unique on org and is_test), so the PARTNER style test path can drill it without
--    touching the real one. A placeholder is never bookable: the CHECK below makes the
--    round robin pool, which reads bookable, unable to route a public booking to it even
--    if a writer forgot, and writeRoutableState (the only writer of bookable) fails loudly
--    on an attempt rather than arming it.
--
-- 2. bookings.kind gains 'staff_placed': a booking on the placeholder. Every reader that
--    reasons about ROUTED bookings already filters kind = 'routed' (0144), so fair share,
--    tier, pilot and race reports leave these out with no new code. A move onto a real
--    advisor sets kind back to 'routed' (#4203).
--
-- 3. bookings.source gains 'coordinator': the booking page coordinators use. It is the
--    page, independent of the kind: a coordinator booking that found a free advisor is
--    routed with this source; one that fell to the placeholder is staff_placed with it.
--    The vocabulary lives in code (src/lib/booking/booking-source.ts) and
--    scripts/test-booking-source.ts holds this constraint equal to it.
--
-- 4. bookings.placed_by_user_id: WHICH person placed it, for the audit and for asking
--    them about a call later. ON DELETE SET NULL, like every other optional user
--    reference on bookings: removing a staff row must never block or delete a booking.
--
-- 5. booking_settings.placeholder_booking_enabled: the go live switch. NOT NULL DEFAULT
--    false, so nothing books onto the placeholder until an admin turns it on, and the
--    reader answers null on a read error, which the booking path refuses (never "on").
--
-- Additive only (new columns with defaults, widened CHECKs), so the deployed code keeps
-- working from the apply to the deploy. Replacing a CHECK re-validates every row, and
-- every existing value is still in each list. The Snowflake export carries kind already,
-- so warehouse readers see 'staff_placed' with no ALTER; placed_by_user_id is not
-- mirrored.

alter table users
  add column is_placeholder boolean not null default false;

alter table users
  add constraint users_placeholder_never_bookable check (not is_placeholder or bookable = false);

create unique index users_one_placeholder_per_org on users (org_id, is_test) where is_placeholder;

comment on column users.is_placeholder is
  'The placeholder advisor (#4200): holds any time bookings a coordinator places when no real advisor is free. At most one per org and is_test; never bookable (users_placeholder_never_bookable); kept out of every advisor screen, picker, pool and monitor by the shared real advisor rule (#4201).';

alter table bookings
  drop constraint bookings_kind_check;

alter table bookings
  add constraint bookings_kind_check check (kind in ('routed', 'agent_link', 'staff_placed'));

comment on column bookings.kind is
  'How a booking was made (#2073, #4200): routed (through a bucket pool, every public booker path and the API), agent_link (an agent''s own named link, which does not route), or staff_placed (placed by a coordinator on the placeholder advisor at a time the customer named, stacked). Every reader that reasons about ROUTED bookings filters on this.';

alter table bookings
  drop constraint bookings_source_check;

alter table bookings
  add constraint bookings_source_check
  check (source in (
    'my-offers-result',
    'booking',
    'booking-agent-eligible',
    'booking-portal',
    'offerhub',
    'rml-portal',
    'email-booking',
    'guided-app',
    'agent-direct',
    'pennie',
    'review-terms',
    'my-offers-result-2',
    'income-landing',
    'not-given',
    'unrecognised',
    'api-regal',
    'api-trypennie',
    'api-canary',
    'mcp-marcia',
    'coordinator'
  ));

alter table bookings
  add column placed_by_user_id uuid references users(id) on delete set null;

comment on column bookings.placed_by_user_id is
  'The person who placed this booking on the coordinator booking page (#4200), whichever advisor it landed on. Null for every booking a lead or a machine made. ON DELETE SET NULL: a removed staff row never blocks or deletes a booking.';

alter table booking_settings
  add column placeholder_booking_enabled boolean not null default false;

comment on column booking_settings.placeholder_booking_enabled is
  'The go live switch for placeholder bookings (#4200). True lets the coordinator booking page place a call on the placeholder advisor when no real advisor is free. NOT NULL DEFAULT false: off until an admin turns it on; an unreadable switch is refused by the booking path, never read as on.';
