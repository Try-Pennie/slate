-- #429 P3: atomic busy_block move. Reschedule/reassign previously did a
-- delete-by-booking then a separate insert; a crash between left the slot
-- momentarily free, re-opening the double-book window. Doing both in one
-- function (one implicit transaction) closes that window. This is the only
-- booking logic in SQL and it is purely mechanical (delete + insert) — no
-- decision logic. Server-only, same posture as rate_limit_hit (0024).

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
  values (p_user_id, p_starts_at, p_ends_at, 'slate', p_booking_id);
end
$$;

revoke execute on function move_busy_block(uuid, uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
