-- #4202, #4203: the kind follows the assignee, and a move onto the placeholder advisor.
--
-- A coordinator places a call on the placeholder (Marcia) when no real advisor in the
-- customer's bucket is free; the call is staff_placed and stacks (allow_double_book).
-- Regal is told which calls sit on the placeholder by booking_kind (#4204), so the kind
-- must be true of the call whichever path last moved it. Plan:
-- https://claude.ai/artifact/XbByMLoaMrBufMr6Chmct1
--
-- 1. bookings_kind_follows_assignee, a BEFORE trigger on every write that names the
--    assignee, the kind or the stack flag:
--      - a booking on a placeholder must be staff_placed AND stack, or it is refused.
--        So a reassign onto the placeholder, a commit_reschedule that would keep a call
--        on it (0206 clears the flag), or a routed insert onto it fails loudly rather
--        than putting a routed call, or one blocking the next stacked call, on Marcia;
--      - an UPDATE moving a staff_placed booking onto a real advisor sets it routed. The
--        lead's reschedule, a manager's reassign, coverage and the bulk sweeps all
--        reach bookings through commit_reschedule or reassign_booking_swap, and both
--        are covered here without touching either, so the marker is right by
--        construction rather than by each path remembering it;
--      - a NEW staff_placed booking, or a relabel, on a real advisor is refused: only a
--        move off the placeholder may turn a call routed, never a mistake at insert.
--    SECURITY DEFINER so its read of users.is_placeholder is never narrowed by a
--    writer's row security; an advisor that does not exist is the foreign key's to
--    refuse, so it lets that through.
--
-- 2. commit_reschedule_onto_placeholder: commit_reschedule (0171, 0206) for a move whose
--    target is the placeholder, with the same fourteen arguments, the same guard and the
--    outbox row in the same transaction. It writes kind staff_placed and
--    allow_double_book true, which commit_reschedule deliberately clears, and refuses
--    (22023) any target that is not the placeholder of the booking's own org and world
--    (a test bucket's call goes to the test placeholder only). A booking that does not
--    exist answers null, as commit_reschedule does.
--
-- Additive only: a new function and a trigger refusing rows nothing deployed writes (no
-- placeholder has a booking before this ships), so the deployed code keeps working from
-- the apply to the deploy. Proved in a real Postgres by
-- scripts/verify-placeholder-booking-sql.ts.

create or replace function bookings_kind_follows_assignee()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_catalog
as $$
declare
  v_placeholder boolean;
begin
  if new.assigned_user_id is null then
    return new;
  end if;
  select u.is_placeholder into v_placeholder from users u where u.id = new.assigned_user_id;
  if v_placeholder is null then
    return new;
  end if;

  if v_placeholder then
    if new.kind <> 'staff_placed' or not new.allow_double_book then
      raise exception 'a booking on the placeholder advisor must be staff_placed and stack (kind %, allow_double_book %)',
        new.kind, new.allow_double_book
        using errcode = 'check_violation', constraint = 'bookings_placeholder_kind';
    end if;
    return new;
  end if;

  if new.kind = 'staff_placed' then
    if tg_op = 'UPDATE' and old.kind = 'staff_placed' then
      -- The call has moved off the placeholder onto a real advisor.
      new.kind := 'routed';
    else
      raise exception 'only a booking on the placeholder advisor is staff_placed'
        using errcode = 'check_violation', constraint = 'bookings_placeholder_kind';
    end if;
  end if;
  return new;
end
$$;

revoke execute on function bookings_kind_follows_assignee() from public, anon, authenticated;

create trigger bookings_kind_follows_assignee
  before insert or update of assigned_user_id, kind, allow_double_book on bookings
  for each row execute function bookings_kind_follows_assignee();

create or replace function commit_reschedule_onto_placeholder(
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
  v_target_ok boolean;
  v_moved     uuid;
  v_outbox_id uuid;
begin
  select coalesce(u.is_placeholder and u.org_id = b.org_id and u.is_test = k.is_test, false)
    into v_target_ok
    from bookings b
    join buckets k on k.id = b.bucket_id
    left join users u on u.id = p_assigned_user_id
   where b.id = p_booking_id;
  if not found then
    return null;
  end if;
  if not v_target_ok then
    raise exception 'commit_reschedule_onto_placeholder: % is not the placeholder of this booking''s org and world', p_assigned_user_id
      using errcode = '22023';
  end if;

  update bookings set
    starts_at         = p_starts_at,
    ends_at           = p_ends_at,
    assigned_user_id  = p_assigned_user_id,
    agent_name        = p_agent_name,
    agent_email       = p_agent_email,
    status            = 'rescheduled',
    gcal_event_id     = p_gcal_event_id,
    reschedule_seq    = p_reschedule_seq,
    -- The placeholder holds any number of calls at one time (#4200), so the call
    -- stacks there, and the kind says it sits on the placeholder (#4204).
    allow_double_book = true,
    kind              = 'staff_placed',
    routing_trace     = case when p_set_routing_trace then p_routing_trace else routing_trace end
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

comment on function commit_reschedule_onto_placeholder(uuid, uuid, text, timestamptz, timestamptz, uuid, text, text, text, int, boolean, jsonb, jsonb, jsonb) is
  'commit_reschedule for a move onto the placeholder advisor (#4202): the gated move as staff_placed and stacking, and its outbox row, in one transaction. Refuses any target but the placeholder of the booking''s org and world. Returns the outbox row id when the move applied, null when the guard matched nothing.';

-- Server side only, like every other SECURITY DEFINER function here. service_role
-- keeps its EXECUTE from the default privileges migration 0121 sets.
revoke execute on function commit_reschedule_onto_placeholder(uuid, uuid, text, timestamptz, timestamptz, uuid, text, text, text, int, boolean, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
