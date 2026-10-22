-- #1677: a coverage move commits only if the booking is still where the sweep saw it.
--
-- The coverage drain reads a booking, picks a covering advisor for its time (a cache
-- read plus a live Google check, seconds), then reassigns it. Anything that changes the
-- booking in between was overwritten by the reassign's unconditional swap:
--   * an admin's own reassign of the call (Place by hand, the booking page, a reroute),
--     so the person they chose was replaced by the sweep's pick;
--   * a second sweep over the same advisor (an offboarding sweep beside a time off one);
--   * the lead rescheduling through their manage link, so the call landed at its NEW
--     time on an advisor only checked free at the OLD one, with allow_double_book set.
-- A cancellation was already safe: the swap refuses a booking gone terminal.
--
-- This adds a sixteen argument form that takes the state the caller verified, the
-- advisor it expects to move the call OFF and the start it checked, and refuses with
-- 'booking_moved' (a word the swap already returns, see 0166) when either differs, under
-- the same row lock the swap takes, so nothing can change between the check and the
-- write. A null expectation checks nothing. It then runs the existing fourteen argument
-- body unchanged, so there is still one reassign body.
--
-- Additive only (docs/migrations-runbook.md, "Deployed code must keep working"): the
-- seven and fourteen argument forms the deployed code calls are untouched, and no
-- argument is defaulted, so a call naming fourteen arguments can never resolve to this.

create or replace function reassign_booking_swap(
  p_booking_id          uuid,
  p_user_id             uuid,
  p_agent_name          text,
  p_agent_email         text,
  p_gcal_event_id       text,
  p_routing_trace       jsonb,
  p_gcal_client_id      text,
  p_bucket_id           uuid,
  p_requested_bucket_id uuid,
  p_requested_tier      text,
  p_booked_tier         text,
  p_rungs_dropped       int,
  p_hold_id             uuid,
  p_result              jsonb,
  p_expected_user_id    uuid,
  p_expected_starts_at  timestamptz
) returns table (prev_gcal_event_id text, prev_agent_email text, updated boolean, refused text)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_bk bookings%rowtype;
begin
  -- The same row lock the body takes, taken first and held to the end of this
  -- transaction, so the state checked here is the state the body writes over.
  select * into v_bk from bookings b where b.id = p_booking_id for update;

  -- A missing or terminal booking is left to the body, which refuses it as it always has.
  if found and v_bk.status not in ('cancelled', 'completed') and (
       (p_expected_user_id is not null and v_bk.assigned_user_id is distinct from p_expected_user_id)
    or (p_expected_starts_at is not null and v_bk.starts_at is distinct from p_expected_starts_at)
  ) then
    return query select null::text, null::text, false, 'booking_moved'::text;
    return;
  end if;

  return query
    select s.prev_gcal_event_id, s.prev_agent_email, s.updated, s.refused
      from reassign_booking_swap(
        p_booking_id          => p_booking_id,
        p_user_id             => p_user_id,
        p_agent_name          => p_agent_name,
        p_agent_email         => p_agent_email,
        p_gcal_event_id       => p_gcal_event_id,
        p_routing_trace       => p_routing_trace,
        p_gcal_client_id      => p_gcal_client_id,
        p_bucket_id           => p_bucket_id,
        p_requested_bucket_id => p_requested_bucket_id,
        p_requested_tier      => p_requested_tier,
        p_booked_tier         => p_booked_tier,
        p_rungs_dropped       => p_rungs_dropped,
        p_hold_id             => p_hold_id,
        p_result              => p_result
      ) s;
end
$$;

revoke execute on function reassign_booking_swap(uuid, uuid, text, text, text, jsonb, text, uuid, uuid, text, text, int, uuid, jsonb, uuid, timestamptz)
  from public, anon, authenticated;
