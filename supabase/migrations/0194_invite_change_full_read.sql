-- #3925: a booking invite found out of step on a FULL read of its advisor's calendar
-- (a bootstrap, a pass after Google expired the sync token, or the daily rotation)
-- is now handed to the moved invite handler, where before it was only mirrored as
-- busy and nobody was told. A full read cannot say when the invite moved, so a first
-- move found that way is reported to the alerts channel and NOT put back, and it is
-- recorded with this new action, `report_full_read`. The record is what makes the
-- move standing: the next full read of it is not reported again, and a further move
-- of the same booking counts as its second.
--
-- Widening a check constraint is additive: the deployed code never writes the new
-- value, so it keeps working between this apply and the deploy (expand then
-- contract). The constraint name is the one Postgres gave 0189's column check,
-- read from production on 2026-10-20.
alter table booking_invite_changes
  drop constraint booking_invite_changes_action_check;

alter table booking_invite_changes
  add constraint booking_invite_changes_action_check check (action in (
    'revert', 'leave_second_move', 'leave_near_start',
    'report_resize', 'report_launch', 'report_full_read'));
