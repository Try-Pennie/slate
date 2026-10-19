-- #3919: the record of a Slate booking's invite moved or resized by its advisor in
-- Google Calendar, and what Slate did about it.
--
-- WHY. Slate writes each booking's invite on the advisor's own calendar as the
-- advisor, and Google never stops an organizer editing their own event. The calendar
-- sync now notices an invite out of step with its booking; Dan's decisions
-- (2026-10-19, the first comment on #3919) put a first move back and leave a SECOND
-- move of the same booking for a person, so Slate has to remember the moves it has
-- seen. Nothing else holds that: Google keeps no history of an event's times, and the
-- booking row keeps only the booked time.
--
-- WHAT A ROW IS. One change Slate saw and acted on: which booking and invite, whether
-- the start moved or only the end, the booked and the invite's times at that moment,
-- Google's `updated` stamp on the event, the action Slate took and, for a revert, how
-- it went. `report_launch` rows come from the one launch sweep (decision 9), which
-- reports invites already out of step without reverting them.
--
-- RUNS TWICE SAFELY. The push sync and the one minute sync can deliver the same
-- change at once. Writing the row is the claim: it is UNIQUE on (booking_id,
-- event_updated), which names one change to one event, and on (booking_id,
-- move_number), so of two runs that both see a booking's next move exactly one
-- records it, and only that run reverts or sends anything. The loser reads 23505.
--
-- No lead contact data: times, ids and Google's stamp only, so retention has nothing
-- to redact here. Not mirrored to Snowflake: it is an operational record, small by
-- construction (one row per advisor edit of an invite), cascading with its booking.
create table booking_invite_changes (
  id               uuid primary key default gen_random_uuid(),
  booking_id       uuid not null references bookings(id) on delete cascade,
  -- The advisor whose calendar held the invite. Cascades with the user like the
  -- booking's own advisor-scoped rows do: a user deleted from Slate has no calendar.
  user_id          uuid not null references users(id) on delete cascade,
  gcal_event_id    text not null,
  kind             text not null check (kind in ('moved', 'resized')),
  -- 1 for the booking's first move, 2 for its second; null for an end only change.
  move_number      int check (move_number >= 1),
  action           text not null check (action in (
                     'revert', 'leave_second_move', 'leave_near_start',
                     'report_resize', 'report_launch')),
  -- How a revert went; null for every other action, and for a revert not finished.
  outcome          text check (outcome in ('reverted', 'revert_refused', 'event_gone')),
  -- Google's short reason for a refused revert.
  outcome_detail   text,
  booked_starts_at timestamptz not null,
  booked_ends_at   timestamptz not null,
  event_starts_at  timestamptz not null,
  event_ends_at    timestamptz not null,
  event_updated    text not null,
  detected_at      timestamptz not null default now(),
  constraint booking_invite_changes_move_number_kind
    check ((kind = 'moved') = (move_number is not null)),
  constraint booking_invite_changes_outcome_action
    check (outcome is null or action = 'revert')
);

-- One row per sighting of one change, and one row per move number of a booking.
create unique index booking_invite_changes_change_key
  on booking_invite_changes (booking_id, event_updated);
create unique index booking_invite_changes_move_key
  on booking_invite_changes (booking_id, move_number);

-- Server reads and writes through the secret key client only; no client access.
alter table booking_invite_changes enable row level security;

comment on table booking_invite_changes is
  'The #3919 record of each Slate booking invite an advisor moved or resized in Google Calendar, and what Slate did: put it back, left it for a person, or reported it. Unique on (booking_id, event_updated) and (booking_id, move_number) so only one run acts on a change.';
