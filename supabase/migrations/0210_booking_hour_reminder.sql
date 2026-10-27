-- #4282: the 1 hour reminder email's durable record, and when the 24 hour one was sent.
--
-- The reminder lane (#2359) sends a second email an hour before the call. It needs its
-- own record of what it has sent, for the same reasons as `reminder_sent_for` (0128):
-- it holds the appointment START the email was sent ABOUT, so a booking that moves
-- earns a fresh one by construction, and the lane claims it BEFORE calling Gmail, so a
-- crash between the two costs an email rather than sending a second copy.
--
-- `reminder_sent_at` is WHEN the 24 hour email was sent. The claim clears it and it is
-- written only once Gmail has accepted the email, so a send that failed never reads as sent.
-- Dan's rule (2026-10-27) is that the 1 hour email is skipped when the 24 hour one went
-- out less than two hours before, so a booking made a few hours ahead is not emailed
-- twice back to back, and `reminder_sent_for` cannot say when. Emails sent before this
-- migration carry null, which the lane reads as "not known" and sends rather than
-- withholds.
--
-- NOT LEAD DATA. Both are instants and carry nothing personal, so neither needs an
-- entry in the erasure function (migration 0092).
--
-- Additive and nullable, so the code deployed when this is applied keeps working: it
-- neither reads nor writes these columns.
alter table bookings
  add column if not exists hour_reminder_sent_for timestamptz,
  add column if not exists reminder_sent_at timestamptz;

comment on column bookings.hour_reminder_sent_for is
  'The appointment start a 1 hour reminder email has been sent about (#4282). Null means none sent. A value that differs from starts_at means the booking moved after it, and the new time earns a fresh one.';

comment on column bookings.reminder_sent_at is
  'When the 24 hour reminder email recorded in reminder_sent_for was sent (#4282), written once Gmail accepted it. Null when not known: sent before this column existed, still being sent, or failed.';
