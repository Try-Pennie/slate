-- #2002: the timezone and the week are ONE change, so they commit or roll back
-- together.
--
-- `replaceUserSchedule` made two writes and its docstring claimed one. It upserted
-- the schedule row with the new timezone, which committed on its own, and then
-- called `replace_availability_rules`. Migration 0097 made that second call atomic,
-- and that is all it made atomic: when the rules write failed the agent was left
-- holding the NEW zone over their OLD hours. Every hour they are bookable moves by
-- the offset between the two zones, nothing reports it, and the form redraws the
-- hours it did not change. The count refusal in the caller had the same shape: it
-- threw after both writes had already run.
--
-- The whole roster is setting its real hours through this path during the parallel
-- run (#1454) and it spans five zones, so a silent two hour shift in when somebody
-- is offered is a live risk rather than a theoretical one.
--
-- This function owns the schedule row as well as its rules. A plpgsql body commits
-- or rolls back as a whole, so a refusal anywhere inside it leaves the agent exactly
-- as they were. It resolves the row by user_id and then calls
-- `replace_availability_rules` rather than repeating the delete and insert, so there
-- is still ONE place that replaces a week and one place that refuses an empty one.
--
-- The expected count is an argument rather than a comparison in the caller, because
-- a comparison in the caller can only run once the transaction has committed, which
-- is the defect this migration exists to remove. The caller still refuses a return
-- it cannot read, which is a different failure (an answer that never arrived) from
-- a write that landed the wrong number of rows.
--
-- The zone is NOT validated here. `planScheduleReplacement` already refuses an
-- unreadable one (#1671) against the same library the availability compute uses, and
-- a second judge in Postgres could refuse a zone that is valid to Luxon and unknown
-- to this server's tzdata, which would be a refusal nobody could act on.
--
-- search_path is pinned per the repo rule. Everything it touches is in `public` and
-- it calls no extension function, so the pin reaches all of it (#1126).
create or replace function replace_user_schedule(
  p_user_id  uuid,
  p_timezone text,
  p_rules    jsonb,
  p_source   text,
  p_expected integer
) returns integer
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_schedule_id uuid;
  v_written     integer;
begin
  if p_timezone is null or btrim(p_timezone) = '' then
    raise exception
      'replace_user_schedule requires a timezone for user % (a blank zone makes every weekday comparison false, so the agent is bookable at no time at all)',
      p_user_id
      using errcode = 'check_violation';
  end if;

  insert into availability_schedules (user_id, timezone)
  values (p_user_id, p_timezone)
  on conflict (user_id) do update set timezone = excluded.timezone
  returning id into v_schedule_id;

  v_written := replace_availability_rules(v_schedule_id, p_rules, p_source);

  if p_expected is not null and v_written <> p_expected then
    raise exception
      'replace_user_schedule wrote % rules for user % where % were asked for, so nothing has been saved',
      v_written, p_user_id, p_expected
      using errcode = 'check_violation';
  end if;

  return v_written;
end;
$$;

comment on function replace_user_schedule(uuid, text, jsonb, text, integer) is
  '#2002: replaces an agent timezone and their whole week in one transaction, so a failed rules write cannot leave the new zone over the old hours.';
