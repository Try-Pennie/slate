-- Atomic reassign swap (#449). reassignBooking had no atomic claim: two
-- concurrent reassigns of the SAME booking to DIFFERENT agents both read the
-- current agent, both created a calendar event, and both updated the booking -
-- leaving one ORPHANED calendar event (the loser's, which the final booking no
-- longer references and nobody deletes).
--
-- The decision (last-write-wins, both reassigns proceed): instead of rejecting a
-- racer, swap atomically and return the event being REPLACED so the caller can
-- delete exactly that. `for update` serializes concurrent reassigns of one
-- booking, so each swap captures and replaces the genuinely-current event - the
-- last swap wins the final assignment and no event is ever left dangling. A
-- terminal (cancelled/completed) booking is not swapped (updated=false), so the
-- caller cleans up the event it had optimistically created.
--
-- The new routing_trace is built by the caller and passed in; under true
-- concurrency its `reassignments.from` reflects the caller's view (audit-only,
-- and this path is low-volume contact-owner automation).

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
  v_prev_gcal  text;
  v_prev_email text;
  v_status     text;
begin
  -- Row-lock so concurrent reassigns of THIS booking serialize: each one reads
  -- and replaces the genuinely-current event, never a stale one.
  select gcal_event_id, agent_email, status
    into v_prev_gcal, v_prev_email, v_status
    from bookings where id = p_booking_id for update;

  if not found or v_status in ('cancelled', 'completed') then
    return query select null::text, null::text, false;
    return;
  end if;

  update bookings set
    assigned_user_id  = p_user_id,
    agent_name        = p_agent_name,
    agent_email       = p_agent_email,
    gcal_event_id     = p_gcal_event_id,
    status            = 'rescheduled',
    allow_double_book = true,
    routing_trace     = p_routing_trace
  where id = p_booking_id;

  return query select v_prev_gcal, v_prev_email, true;
end
$$;

revoke execute on function reassign_booking_swap(uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated;
