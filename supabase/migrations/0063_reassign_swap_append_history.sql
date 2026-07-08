-- #519: append the reassignment audit record INSIDE reassign_booking_swap under
-- the row lock, instead of the caller writing a whole routing_trace array built
-- from a snapshot read BEFORE the swap. Two near-simultaneous reassigns of the
-- same booking (last-write-wins, #449) each built the array from the same stale
-- base, so the later swap overwrote rather than appended: the final assignment
-- was correct but one history entry was lost.
--
-- The fix keeps the SAME signature and return shape (so it is backward compatible
-- across the code/migration rollout: no window where a caller hits a missing
-- overload). The reassignment record is now DERIVED and appended server-side: the
-- `for update` read already yields the genuinely-current agent (the record's
-- `from`), p_user_id is the `to`, and now() is the `at`. p_routing_trace is used
-- only to SEED a row that has no trace yet; when the row has one, the append is
-- onto the row's own current history, so concurrent reassigns serialize and
-- accumulate full history. Deriving `from` under the lock is also strictly more
-- correct than the caller's pre-swap view.
create or replace function reassign_booking_swap(
  p_booking_id    uuid,
  p_user_id       uuid,
  p_agent_name    text,
  p_agent_email   text,
  p_gcal_event_id text,
  p_routing_trace jsonb
) returns table (prev_gcal_event_id text, prev_agent_email text, updated boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev_gcal   text;
  v_prev_email  text;
  v_status      text;
  v_prev_user   uuid;
  v_trace       jsonb;
  v_base        jsonb;
  v_existing    jsonb;
begin
  -- Row-lock so concurrent reassigns of THIS booking serialize: each one reads
  -- and appends onto the genuinely-current trace, never a stale caller snapshot.
  select gcal_event_id, agent_email, status, assigned_user_id, routing_trace
    into v_prev_gcal, v_prev_email, v_status, v_prev_user, v_trace
    from bookings where id = p_booking_id for update;

  if not found or v_status in ('cancelled', 'completed') then
    return query select null::text, null::text, false;
    return;
  end if;

  -- Seed from the row's own trace; fall back to the caller base only when the row
  -- has none yet. Coalesce a missing/non-array reassignments to an empty array so
  -- the append is always onto a real jsonb array.
  v_base := coalesce(v_trace, p_routing_trace);
  v_existing := case
    when jsonb_typeof(v_base -> 'reassignments') = 'array' then v_base -> 'reassignments'
    else '[]'::jsonb
  end;

  update bookings set
    assigned_user_id  = p_user_id,
    agent_name        = p_agent_name,
    agent_email       = p_agent_email,
    gcal_event_id     = p_gcal_event_id,
    status            = 'rescheduled',
    allow_double_book = true,
    routing_trace     = jsonb_set(
      v_base,
      '{reassignments}',
      v_existing || jsonb_build_array(
        jsonb_build_object('from', v_prev_user::text, 'to', p_user_id::text, 'at', now())
      ),
      true
    )
  where id = p_booking_id;

  return query select v_prev_gcal, v_prev_email, true;
end
$$;

revoke execute on function reassign_booking_swap(uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated;
