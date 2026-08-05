-- Replace a schedule's weekly rules in ONE transaction (#1293).
--
-- The server action deleted every rule for a schedule and then inserted the new
-- ones as two separate statements, so anything failing in between left the agent
-- with NO rules at all. An agent with no rules has no working hours, which means
-- no availability in any bucket, silently, while the form that did it reported a
-- successful save. Ordering in application code cannot close that window; one
-- function can, because a plpgsql body commits or rolls back as a whole.
--
-- The empty-set refusal is deliberately IN THE DATABASE and not only in the
-- action. Clearing a schedule is indistinguishable from a legitimate save that
-- happened to produce nothing, and the consequence (an agent quietly unbookable)
-- is bad enough that no future caller should be able to reach it by forgetting a
-- check. Taking an agent out of the pool is what `users.bookable` is for.
--
-- Deliberately NOT adding a unique index on (schedule_id, weekday): several
-- windows on one weekday is a real capability the compute already honours
-- (isWithinWorkingHours loops every rule matching the day), and the shared
-- business-hours predicate depends on keeping it.
--
-- search_path is pinned per the repo rule. Everything it touches is in `public`
-- and every function it calls (jsonb_array_length, jsonb_array_elements) is a
-- pg_catalog built-in, so a pinned path can still reach them.
create or replace function replace_availability_rules(
  p_schedule_id uuid,
  p_rules       jsonb
) returns integer
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_written integer;
begin
  if p_rules is null or jsonb_typeof(p_rules) <> 'array' or jsonb_array_length(p_rules) = 0 then
    raise exception
      'replace_availability_rules refuses an empty rule set for schedule % (an agent with no rules is silently unbookable; use users.bookable instead)',
      p_schedule_id
      using errcode = 'check_violation';
  end if;

  delete from availability_rules where schedule_id = p_schedule_id;

  insert into availability_rules (schedule_id, weekday, start_minute, end_minute)
  select
    p_schedule_id,
    (r ->> 'weekday')::int,
    (r ->> 'start_minute')::int,
    (r ->> 'end_minute')::int
  from jsonb_array_elements(p_rules) as r;

  -- Report what actually landed, so the caller can refuse to claim success on a
  -- count it did not get (never a bare "done").
  select count(*) into v_written from availability_rules where schedule_id = p_schedule_id;
  return v_written;
end;
$$;
