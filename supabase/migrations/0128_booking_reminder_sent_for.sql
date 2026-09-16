-- #2359: the 24 hour reminder email's durable record of what it has already sent.
--
-- Today a lead booked through cal.com gets four messages before their call, and all
-- four are cal.com features that stop at cutover. The confirmation is covered by the
-- Google invite (#64) and the 1 hour and 15 minute reminders by Regal's SMS journeys
-- (#2308, #2309). The 24 hour reminder is covered by nothing, and this is it.
--
-- WHY A TIMESTAMP RATHER THAN A BOOLEAN. The column holds the appointment START the
-- reminder was sent ABOUT, not the fact that one was sent. A booking that moves earns
-- a fresh reminder for its new time (Dan, 2026-09-16), and a boolean cannot express
-- that: it would leave a lead who rescheduled from tomorrow to a fortnight away with
-- no reminder at all, and the one they did get describing a time that no longer
-- exists. Comparing this against `starts_at` answers both questions with one column,
-- and a reschedule invalidates the record by construction rather than by anybody
-- remembering to clear it (L60: a stored fact should carry what it is a fact ABOUT).
--
-- IT IS CLAIMED BEFORE THE SEND, never after. The job writes this column and only
-- then calls Gmail, so a crash between the two costs a reminder rather than sending a
-- second copy to a real person. That is the deliberate direction: the send is not
-- transactional with the write, and of the two ways to be wrong, a lead who hears
-- nothing is recoverable and a lead who gets the same email twice is not. A send that
-- fails after the claim is alerted rather than silently retried, so the gap is
-- visible (#2359, L12).
--
-- NOT LEAD DATA. It is an instant, so it carries nothing personal and needs no entry
-- in the erasure function (migration 0092): redacting the booking's contact columns
-- leaves nothing here to miss. It rides the bookings row into the Snowflake mirror
-- like every other column on the table.
alter table bookings
  add column if not exists reminder_sent_for timestamptz;

comment on column bookings.reminder_sent_for is
  'The appointment start a 24 hour reminder email has been sent about (#2359). Null means none sent. A value that differs from starts_at means the booking moved after its reminder, and the new time earns a fresh one.';

-- The job asks one question every five minutes: which confirmed bookings start inside
-- the next 24 hours and have no reminder recorded for the start they now hold? This
-- index is that question's shape. Partial on the statuses a reminder can belong to,
-- because a cancelled booking is never reminded about and including those rows would
-- grow the index with entries no query ever reads.
create index if not exists bookings_reminder_due_idx
  on bookings (starts_at)
  where status in ('confirmed', 'rescheduled');
