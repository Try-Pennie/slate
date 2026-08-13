-- #1464: give an approved time off's busy_block an owner the sweeps can see.
--
-- `busy_blocks` had exactly two kinds of row: a mirror of an agent's Google
-- calendar (source='gcal'), and a Slate booking's write-through (source='slate'
-- with a booking_id). So "source='slate' and booking_id is null" meant orphan,
-- and the reconcile sweep freed it on that rule.
--
-- The OOO fallback (src/lib/ooo/orchestration.ts) is a THIRD writer of exactly
-- that shape, and its row is the only thing blocking the window when the agent's
-- calendar event could not be created. On 2026-08-13 the sweep deleted one 31
-- seconds after it was written, and because ooo_requests.busy_block_id is
-- ON DELETE SET NULL the record was left saying no block had ever existed.
--
-- ON DELETE SET NULL here too, deliberately: deleting an ooo_requests row must
-- not cascade into deleting cached availability. The block simply stops having a
-- live owner, at which point the reconcile sweep frees it on the ordinary orphan
-- rule, which is the correct outcome and is counted rather than silent.
alter table busy_blocks
  add column ooo_request_id uuid references ooo_requests(id) on delete set null;

-- The reconcile sweep and both pool-exit prunes now filter on this column
-- (`is null` for the rows they may delete, `not null` for the ones they must
-- keep). Partial, because owned rows are a tiny minority of the table: one per
-- approved future time off, against one per cached busy period per agent.
create index if not exists busy_blocks_ooo_request_id_idx
  on busy_blocks (ooo_request_id) where ooo_request_id is not null;
