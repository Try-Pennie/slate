-- #3592: the reconcile-missing sweep's re-create, as ONE statement.
--
-- The sweep (#431) re-creates the write-through busy_block of an active upcoming
-- booking that has none. #3585 narrowed its cancel race to the gap between a
-- client side re-verify (loadStillActiveBookingIds) and the insert that followed;
-- a cancel landing in that gap still re-created one block for a cancelled booking,
-- and the next tick freed it and paged. Here the active check and the insert are
-- one INSERT ... SELECT, so nothing can land between them.
--
-- `for share of b` is what makes that true under READ COMMITTED, not the single
-- statement alone. Without it the SELECT reads a snapshot and the insert takes only
-- the foreign key's KEY SHARE lock, which a cancel's status UPDATE does not wait
-- for, so a cancel committing mid statement was still missed. With it, a cancel
-- already in flight makes this wait, and the row is then re-checked as committed
-- (cancelled, so skipped); a cancel arriving later waits for this to commit, and
-- its own busy_block delete step then removes the row. Rows are locked in id order.
--
-- Every guard the client side loader and re-verify applied is inside the WHERE:
--   * status confirmed or rescheduled, the booking still upcoming, assigned;
--   * created before p_created_before, the #778 grace (RECONCILE_MISSING_GRACE_MS,
--     passed in so the constant has one home);
--   * the agent still in the pool by hasLeftPool's SQL form (#3304,
--     whereStillInPool in src/lib/bookable/left-pool.ts): not deactivated, and
--     bookable or owed an activation (bookable_pending_since set).
-- ON CONFLICT on busy_blocks_booking_id_uniq (0067) skips a booking whose block
-- exists, including one its own write through or move_busy_block lands meanwhile.
-- RETURNING names only the rows actually inserted, so the sweep counts and pages
-- about real rows.
--
-- The values come from the booking row itself, read under the lock, rather than
-- from the sweep's earlier read, so a reschedule or reassign meanwhile is honoured.
--
-- Security INVOKER: the server calls it as service_role, which owns the rights it
-- needs. Pinned search_path, pg_catalog built ins only (now()). Additive: the code
-- already deployed never names it.
create or replace function recreate_missing_busy_blocks(
  p_booking_ids     uuid[],
  p_created_before  timestamptz
) returns table (booking_id uuid, user_id uuid)
language sql
security invoker
set search_path = public
as $$
  insert into busy_blocks (user_id, starts_at, ends_at, source, booking_id)
  select b.assigned_user_id, b.starts_at, b.ends_at, 'slate', b.id
  from bookings b
  join users u on u.id = b.assigned_user_id
  where b.id = any(p_booking_ids)
    and b.status in ('confirmed', 'rescheduled')
    and b.ends_at >= now()
    and b.assigned_user_id is not null
    and b.created_at < p_created_before
    and u.deactivated_at is null
    and (u.bookable or u.bookable_pending_since is not null)
  order by b.id
  for share of b
  on conflict (booking_id) do nothing
  returning busy_blocks.booking_id, busy_blocks.user_id;
$$;

revoke execute on function recreate_missing_busy_blocks(uuid[], timestamptz)
  from public, anon, authenticated;
