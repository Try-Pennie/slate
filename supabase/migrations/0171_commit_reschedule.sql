-- Commit a reschedule and record its outbox work in ONE transaction (#3265).
--
-- The reschedule path committed the move with a gated UPDATE and then queued its
-- side effects (the slot move, the recompute, the rescheduled webhook to Regal) with a
-- SEPARATE outbox insert. A failed insert, or a process that died between the two,
-- left a committed move with no durable record of the work after it: the old slot
-- stayed blocked and Regal never heard the call had moved. The new booking path closed
-- the same gap in #3263 by keeping its reservation pending until the work after it
-- landed; a reschedule has no reservation, so the record goes into the commit itself.
--
-- WHAT IT DOES. Applies the move only while the booking is still active AND its
-- assignee and event id are the ones the caller read (the #615 guard, exactly as the
-- UPDATE it replaces checked them: a concurrent cancel or reassign touches nothing),
-- and when it applied, inserts the reschedule outbox row in the same transaction.
--
-- WHAT IT ANSWERS. The outbox row's id when the move applied, or null when the guard
-- matched nothing. Null is not an error: the caller re-reads the booking to tell a
-- real conflict from an earlier attempt that already committed this exact move, whose
-- own call wrote the outbox row the drain will run.
--
-- The steps and payload are built by the caller (`rescheduleOutboxSteps` and the
-- reason it was given), the same values the separate insert carried, so the outbox
-- executor and the drain read exactly what they read before.
create or replace function commit_reschedule(
  p_booking_id        uuid,
  p_guard_assigned    uuid,
  p_guard_event       text,
  p_starts_at         timestamptz,
  p_ends_at           timestamptz,
  p_assigned_user_id  uuid,
  p_agent_name        text,
  p_agent_email       text,
  p_gcal_event_id     text,
  p_reschedule_seq    int,
  p_set_routing_trace boolean,
  p_routing_trace     jsonb,
  p_steps             jsonb,
  p_payload           jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_catalog
as $$
declare
  v_moved     uuid;
  v_outbox_id uuid;
begin
  update bookings set
    starts_at        = p_starts_at,
    ends_at          = p_ends_at,
    assigned_user_id = p_assigned_user_id,
    agent_name       = p_agent_name,
    agent_email      = p_agent_email,
    status           = 'rescheduled',
    gcal_event_id    = p_gcal_event_id,
    reschedule_seq   = p_reschedule_seq,
    -- A move to another advisor carries a trace with the move recorded (#2916); a
    -- move that keeps the advisor leaves the stored trace as it is.
    routing_trace    = case when p_set_routing_trace then p_routing_trace else routing_trace end
  where id = p_booking_id
    and status in ('confirmed', 'rescheduled')
    and assigned_user_id is not distinct from p_guard_assigned
    and gcal_event_id is not distinct from p_guard_event
  returning id into v_moved;

  if v_moved is null then
    return null;
  end if;

  insert into booking_outbox (booking_id, action, steps, payload)
  values (p_booking_id, 'reschedule', p_steps, p_payload)
  returning id into v_outbox_id;

  return v_outbox_id;
end;
$$;

comment on function commit_reschedule(uuid, uuid, text, timestamptz, timestamptz, uuid, text, text, text, int, boolean, jsonb, jsonb, jsonb) is
  'Apply a gated reschedule and record its outbox work in the same transaction (#3265). Returns the outbox row id when the move applied, null when the guard matched nothing.';

-- Server side only, like every other SECURITY DEFINER function here. service_role
-- keeps its EXECUTE from the default privileges migration 0121 sets.
revoke execute on function commit_reschedule(uuid, uuid, text, timestamptz, timestamptz, uuid, text, text, text, int, boolean, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
