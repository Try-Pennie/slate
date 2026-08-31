-- #1665: let a coverage sweep be STOPPED when the time off that caused it is
-- cancelled, or narrowed by a modification.
--
-- Approving time off enqueues a sweep that moves the agent's upcoming customer
-- appointments to colleagues (#1237). Cancelling the time off used to tear down
-- the calendar events and the busy block and say nothing to the sweep, so it
-- carried on moving customers away from an advisor who is now going to be there,
-- and each of them got an invite from somebody else.
--
-- Stopping it needs a terminal state that is NOT one of the existing five item
-- outcomes. 'skipped' is the closest and it would be a lie: it means the booking
-- was cancelled or completed before we could move it, which is a fact about the
-- booking. This is a fact about the sweep, and the difference decides what the
-- admin panel and the #1242 give-up page say about the row (L11).
--
-- The cancellation itself is a conditional UPDATE on these values rather than
-- ordering in application code: the cancel flips pending items to 'cancelled'
-- WHERE status = 'pending', and the drain commits an item's outcome WHERE its
-- status is still one it is allowed to leave. The two writes contend for the same
-- row, so Postgres decides which one wins and there is no interleaving in which a
-- booking is moved twice or an item is left pending under a stopped sweep.
--
-- No data migration: every existing row keeps the status it has. The new value is
-- only ever written from here on.
alter table bulk_reassign_jobs
  drop constraint bulk_reassign_jobs_status_check;

-- 'cancelled' is terminal for a job exactly as 'done' is, and distinct from it on
-- purpose: 'done' means every item reached an outcome, 'cancelled' means the
-- reason for the sweep went away. markBulkReassignJobDoneIfDrained only ever
-- flips a job that is still 'active', so a cancelled sweep can never be relabelled
-- 'done' by the tick that drained its last in-flight item.
alter table bulk_reassign_jobs
  add constraint bulk_reassign_jobs_status_check
  check (status in ('active', 'done', 'cancelled'));

alter table bulk_reassign_items
  drop constraint bulk_reassign_items_status_check;

-- 'cancelled' means this appointment was still waiting to move when the time off
-- was cancelled, so it was never moved and stays with the agent it was already
-- with. An item that HAD already moved keeps 'moved' (#1219 decision 4: cancelling
-- the time off does not move a customer back).
alter table bulk_reassign_items
  add constraint bulk_reassign_items_status_check
  check (status in ('pending', 'moved', 'unplaceable', 'skipped', 'failed', 'cancelled'));

comment on column bulk_reassign_jobs.status is
  'active while the sweep still has pending items, done once every item reached an outcome, cancelled when the time off that caused it was cancelled or narrowed (#1665). All three are read by the drain; only active is drained.';

comment on column bulk_reassign_items.status is
  'pending, moved, unplaceable, skipped, failed, or cancelled (#1665: still waiting to move when the time off was cancelled, so it never moved).';
