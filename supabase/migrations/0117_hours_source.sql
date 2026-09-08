-- #1753: record who set an agent's working hours, so a seeded default stops
-- reading as a deliberate choice.
--
-- Every one of 117 agents carried the same seeded week for months because nobody
-- had edited it, and 81 of 100 turned out to keep different hours (#1738). Nothing
-- could report it: a stored week is a valid week whether or not the agent keeps
-- it. These two columns make "nobody has set this" a recorded fact.
--
-- The stamp is written INSIDE replace_availability_rules, the one transaction
-- every hours editor, the org default fill and the cal.com import already go
-- through, so a writer cannot forget it: the function now REQUIRES a source and
-- refuses one outside the vocabulary. The old two-argument signature is dropped
-- rather than kept as an overload, so a caller that has not been updated fails
-- loudly at the call instead of silently writing an unstamped week.
--
-- Nullable, no backfill, on purpose. The rows that already exist were written
-- before the stamp and nothing can know who set them (L223); the detector reads
-- the store's own evidence for those (a week still shaped exactly like the org
-- default was never touched) and the stamp for everything after.
alter table public.availability_schedules
  add column if not exists hours_source text
    check (hours_source in ('seed', 'agent', 'admin', 'calcom-import')),
  add column if not exists hours_set_at timestamptz;

comment on column public.availability_schedules.hours_source is
  '#1753: who last wrote this week through replace_availability_rules. null = written before the stamp existed.';

drop function if exists public.replace_availability_rules(uuid, jsonb);

-- search_path is pinned per the repo rule. Everything it touches is in `public`
-- and it calls no extension function, so the pin reaches all of it (#1126).
create or replace function replace_availability_rules(
  p_schedule_id uuid,
  p_rules       jsonb,
  p_source      text
) returns integer
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_written integer;
begin
  if p_source is null or p_source not in ('seed', 'agent', 'admin', 'calcom-import') then
    raise exception
      'replace_availability_rules requires a source in (seed, agent, admin, calcom-import); got %',
      coalesce(p_source, 'null')
      using errcode = 'check_violation';
  end if;

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

  update availability_schedules
     set hours_source = p_source,
         hours_set_at = now()
   where id = p_schedule_id;

  -- Report what actually landed, so the caller can refuse to claim success on a
  -- count it did not get (never a bare "done").
  select count(*) into v_written from availability_rules where schedule_id = p_schedule_id;
  return v_written;
end;
$$;
