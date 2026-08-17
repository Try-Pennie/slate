-- #1260: the two columns the calendar hydration rotation needs, plus the index its
-- prune needs. Columns and an index only; nothing reads them yet (#1261 is the lane).

-- WHY TWO COLUMNS AND NOT ONE. They answer different questions and one field cannot
-- carry both signals, because they move at different moments and one of them must move
-- even when the fetch fails.

-- Advances on ATTEMPT, before the fetch, and drives rotation fairness only.
--
-- Without it, ordering the rotation by coverage means a calendar whose delegation has
-- been revoked can never succeed, so it stays the oldest forever and is selected first
-- on every tick, starving every healthy calendar behind it. `syncEligible`'s own comment
-- (src/lib/google/sync-coalesce.ts) records that no such column exists and why neither
-- `last_success_at` nor `consecutive_failures` can answer "when did we last try":
-- last_success_at stops moving the moment a calendar starts failing, and skipping an
-- attempt records no failure, so the counter freezes at whatever value caused the skip.
alter table agent_calendars
  add column last_bootstrap_attempt_at timestamptz;

-- The `timeMax` ACTUALLY SENT on the last SUCCESSFUL bootstrap. Authorizes the prune
-- (#1265) and feeds the coverage alert (#1262).
--
-- Stored rather than derived from the attempt stamp plus a constant, deliberately. A
-- derived value would restate coverage from today's window size, so changing that size
-- would silently claim coverage for a range that was never fetched, and the prune it
-- authorizes would then delete cached busy time inside a window nothing had read. The
-- stored value can only ever describe a request that really happened.
alter table agent_calendars
  add column sync_window_to timestamptz;

-- NO BACKFILL, on purpose. Null must read as "we have never established coverage for
-- this calendar", which is the fail-safe side: every reader maps null to "due" or "no
-- coverage" rather than to a window. Backfilling either column with now() or a computed
-- range would manufacture coverage for calendars that have not been bootstrapped since
-- June, and the prune would act on it.

-- RLS needs no change: policies on agent_calendars are table-scoped, not column-scoped,
-- so the existing default-deny policy already covers both new columns. Server code
-- reaches this table through the secret-key client, which bypasses RLS anyway.

-- The index the out-of-window prune needs (#1265). Its candidate read is
--   select id from busy_blocks
--   where source = 'gcal' and booking_id is null and ends_at < <cutoff>
--   order by ends_at asc limit N
-- (src/app/api/cron/prune-busy-blocks/route.ts), which today plans as a sequential scan.
--
-- Partial on exactly the predicate, and keyed on ends_at, so the scan is an index range
-- in the order the query already asks for and the sort disappears.
--
-- A note on the justification, because the figure in #1260 can no longer be reproduced:
-- it recorded 69 ms per batch over 60 batches, measured when the table held a real
-- backlog. busy_blocks holds 10 rows today (#1538: the roster is dark before cutover, so
-- almost no calendar is re-read), and the same query now plans in 0.13 ms. The index is
-- still right for the design target of 100 to 200 agents, and it is being added on that
-- basis rather than on a timing anybody can currently measure.
create index if not exists busy_blocks_gcal_prune_idx
  on busy_blocks (ends_at)
  where source = 'gcal' and booking_id is null;
