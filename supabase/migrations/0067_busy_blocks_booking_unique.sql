-- #770: one slate busy_block per booking, enforced by the database.
--
-- Nothing stopped two slate rows existing for one booking. The create/reschedule
-- paths are safe on their own (move_busy_block deletes by booking_id and re-inserts
-- in one transaction), but the reconcile-missing sweep reads which bookings lack a
-- block and then inserts. A booking's own move_busy_block can land in that gap, and
-- the sweep then adds a second row. The sweep has no age guard and scans newest
-- bookings first (loadActiveUpcomingBookings orders created_at DESC), which is
-- exactly the window where the block may not have landed yet.
--
-- A duplicate block makes the agent look busier than they are, so slots silently
-- stop being offered. Ordering in application code cannot close this; a constraint
-- can.
--
-- NOT a partial index, deliberately. The gcal mirror rows all carry a NULL
-- booking_id and Postgres treats NULLs as distinct, so a plain unique index already
-- leaves them alone (the same trick 0022 used for gcal_event_id). A PARTIAL index
-- would be worse than useless here: PostgREST/supabase-js upsert emits a bare
-- ON CONFLICT (cols), which Postgres cannot match to a partial index (42P10): the
-- exact bug 0022 had to fix on this very table.
--
-- Verified against production before writing this: 515,157 gcal rows (all NULL
-- booking_id), 2 slate rows, ZERO duplicates, so the index builds cleanly.
create unique index if not exists busy_blocks_booking_id_uniq
  on busy_blocks (booking_id);

-- Superseded: a unique index serves every lookup the plain one did (#429 P3's
-- delete-by-booking and the sweep's block-existence probe).
drop index if exists busy_blocks_booking_id_idx;

-- move_busy_block must SETTLE on a conflict rather than error. It deletes by
-- booking_id first, so it can only collide with a row a concurrent sweep committed
-- in between. When that happens the booking's own write is the authority on
-- where the block belongs, so it wins and rewrites the row. Without this, the new
-- unique index would turn that race into a failed booking-path write.
create or replace function move_busy_block(
  p_booking_id uuid,
  p_user_id    uuid,
  p_starts_at  timestamptz,
  p_ends_at    timestamptz
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only slate rows carry a booking_id, so this never touches a gcal mirror.
  delete from busy_blocks where booking_id = p_booking_id;
  insert into busy_blocks (user_id, starts_at, ends_at, source, booking_id)
  values (p_user_id, p_starts_at, p_ends_at, 'slate', p_booking_id)
  on conflict (booking_id) do update
    set user_id   = excluded.user_id,
        starts_at = excluded.starts_at,
        ends_at   = excluded.ends_at,
        source    = excluded.source;
end
$$;

revoke execute on function move_busy_block(uuid, uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
