-- #2617: a reassign leaves the booking status as it found it.
--
-- The swap stamped status = 'rescheduled' on every call, whether or not the time
-- moved. "rescheduled" is read as "the lead moved their call" by the admin badges,
-- the booking outcomes page and the show rate grouping, so every owner hand-back
-- (which fires on every returning lead with engagement) was counted as a lead
-- rescheduling a call they never touched. Found in the Phase A walk (#2308):
-- booking 24e012c3 read rescheduled with reschedule_seq 0 and its original time.
--
-- The reassign is already recorded where it belongs: assigned_user_id, the
-- routing_trace reassignments array appended below, and the 'reassigned' row in
-- booking_events. A booking the lead really did move keeps 'rescheduled'.
--
-- Same 7-arg signature as 0069, replaced in place, so the deployed code calls the
-- new body the moment this applies and there is no overload window. No backfill:
-- measured 2026-09-22, no booking is confirmed or rescheduled at all (2,561
-- cancelled, 3 completed), so no live row carries the wrong stamp.
create or replace function reassign_booking_swap(
  p_booking_id     uuid,
  p_user_id        uuid,
  p_agent_name     text,
  p_agent_email    text,
  p_gcal_event_id  text,
  p_routing_trace  jsonb,
  p_gcal_client_id text
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
  -- has none yet (#519).
  v_base := coalesce(v_trace, p_routing_trace);
  v_existing := case
    when jsonb_typeof(v_base -> 'reassignments') = 'array' then v_base -> 'reassignments'
    else '[]'::jsonb
  end;

  -- No status write (#2617): a reassign hands the same call to another advisor,
  -- so the row keeps whatever the LEAD's own actions left it as.
  update bookings set
    assigned_user_id  = p_user_id,
    agent_name        = p_agent_name,
    agent_email       = p_agent_email,
    gcal_event_id     = p_gcal_event_id,
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

  -- The swap has committed (same transaction as the update above). Stamp the intent
  -- with the event this swap REPLACED, so the sweep can finish an interrupted
  -- delete-old, and with swapped_at, so the sweep can tell a committed-then-superseded
  -- reassign from one that was never adopted (#758). No-ops harmlessly if the intent
  -- row is already gone (a same-target retry that completed).
  update reassign_intents set
    prev_agent_email   = v_prev_email,
    prev_gcal_event_id = v_prev_gcal,
    swapped_at         = now()
  where booking_id = p_booking_id
    and gcal_client_id = p_gcal_client_id;

  return query select v_prev_gcal, v_prev_email, true;
end
$$;

revoke execute on function reassign_booking_swap(uuid, uuid, text, text, text, jsonb, text)
  from public, anon, authenticated;
