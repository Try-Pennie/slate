-- #759: record the reassign intent INSIDE the swap's transaction.
--
-- #518 recorded the REPLACED old event on the intent as a separate write straight
-- after the swap, leaving a sub-millisecond window. A crash in between:
--   * lost the old event id, so the sweep could never clean the orphaned event
--     (the original, cosmetic-only complaint), and
--   * since #758, left swapped_at unset on a swap that HAD committed, which the
--     sweep reads as a never-adopted (LOST) reassign and pages about. A false
--     "this reassignment was silently lost, re-run it" for one that succeeded.
-- Ordering in application code cannot close that. One transaction can: the booking
-- update and the intent stamp now commit together or not at all.
--
-- NEW 7-arg overload, and the 6-arg one from 0063 is deliberately LEFT IN PLACE:
-- the currently-deployed code still calls it during the deploy window, and this
-- migration must land BEFORE that code (Slate does not auto-apply migrations, #482).
-- A DEFAULTED 7th parameter would have been worse than a new overload: a 6-arg call
-- would then match both functions and Postgres would fail it as not-unique, breaking
-- the running code. Distinct arities are unambiguous. The dead 6-arg version is
-- dropped in a follow-up once this has deployed.
--
-- p_gcal_client_id is passed explicitly rather than reusing p_gcal_event_id. They are
-- the same string today (Google echoes back the deterministic client id we supply),
-- but keying the intent row on an assumed identity would fail SILENTLY if that ever
-- stopped holding: the stamp would match zero rows and the sweep would quietly go back
-- to misreading a committed swap as a lost reassign.
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
