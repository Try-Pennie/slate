-- #4199: a reschedule clears allow_double_book.
--
-- A reassign sets allow_double_book (0017, and the swap functions after it) so the call
-- may stack on the advisor it was forced onto. commit_reschedule (0171) moved the call
-- to a new time and advisor without touching the flag, so a reassigned call that was
-- later rescheduled carried the exemption with it: on its NEW advisor it skipped
-- 0017's active slot unique index and 0120's overlap constraint, so a second call could
-- be written over it at the database level, and the buffer breach monitor
-- (src/lib/monitor/buffer-breach.ts) counted the clash as forced and never paged.
--
-- Every reschedule lands on a time checked free for the advisor it goes to, in place
-- (isBookableSlotForAgent) or rerouted (verify on book), so the flag is cleared on
-- EVERY applied move, keeping the advisor or not. A move whose guard matches nothing
-- writes nothing, the flag included.
--
-- Same signature as 0171, so the deployed code calls it unchanged (an additive
-- change: no window in which a caller names arguments the function lacks). Proved in
-- a real Postgres by scripts/verify-commit-reschedule-sql.ts.
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
    -- #4199: the new time was checked free for the advisor it goes to, so the call no
    -- longer stacks on purpose. Left true, a reassigned call that later moves keeps
    -- its exemption from 0017's unique index and 0120's overlap constraint on its
    -- new advisor, and the buffer breach monitor classes any clash there as forced.
    allow_double_book = false,
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
