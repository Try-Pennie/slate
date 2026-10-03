-- #2702: an imported week refuses to land over a week somebody edited while the
-- import ran.
--
-- The activation gate imports an agent's cal.com week only when their stored week
-- is still the seeded default (#2627). It reads the row, judges it with
-- `isUnsetHours`, asks cal.com, and only then writes through
-- `replace_user_schedule`. Those are separate steps, so an admin or agent save
-- landing between the read and the write was overwritten by the import, and nothing
-- said so. The window is one cal.com read long, and the outcome is the silent loss
-- of a human edit, which nothing repairs.
--
-- So the condition moves INTO the write. This adds a SIX argument form,
-- `replace_user_schedule(..., p_only_if_source)`, which locks the agent's schedule
-- row, compares its `hours_source` against the source the caller read, and raises
-- SQLSTATE SL409 when they differ, before anything is written. The compare is
-- `is distinct from`, so a null means "still unstamped" (a row written before
-- migration 0117, judged by its shape) and is a real guard rather than no guard.
-- The lock is `for update`, the same row lock the write's own upsert takes, so a
-- save that commits first is seen here, and a save that starts after the lock waits
-- and then wins, which is the right order for a person's edit.
--
-- A missing row refuses too: the caller judged a row it read, and a row that has
-- gone is not the one it judged.
--
-- SL409 is a custom code rather than a message the client matches, so rewording
-- the exception cannot turn the refusal back into an ordinary failure. The client
-- reports it as its own reason, `hours-changed-during-import`, not as a failed write.
--
-- STEP ONE OF ONE, deliberately additive. The FIVE argument form from migration 0129
-- is kept, unchanged and permanently, not as a transitional overload: the admin
-- save, the agent save and the daily importer (whose rule is to overwrite an admin
-- edit, Dan 2026-09-10) all call it unguarded and still should. Neither form has a
-- default, so PostgREST resolves a call by the argument names it carries and the
-- two can never be ambiguous. Applied before the code deploys, the deployed code
-- keeps calling the five argument form and nothing changes for it.
--
-- The new form delegates to the five argument one for the write, so there is still
-- ONE place that replaces a week, and the guard and the write share one transaction.
--
-- search_path is pinned per the repo rule. Everything it touches is in `public` and
-- it calls no extension function, so the pin reaches all of it (#1126).
create or replace function replace_user_schedule(
  p_user_id         uuid,
  p_timezone        text,
  p_rules           jsonb,
  p_source          text,
  p_expected        integer,
  p_only_if_source  text
) returns integer
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_found   boolean;
  v_current text;
begin
  select true, hours_source
    into v_found, v_current
    from availability_schedules
   where user_id = p_user_id
   for update;

  if v_found is null then
    raise exception
      'replace_user_schedule found no schedule row for user %, so the week it was asked to replace is not the one the caller read; nothing has been saved',
      p_user_id
      using errcode = 'SL409';
  end if;

  if v_current is distinct from p_only_if_source then
    raise exception
      'replace_user_schedule: the hours for user % are now set by %, not %, so somebody saved them while this write was prepared; nothing has been saved',
      p_user_id, coalesce(v_current, 'nobody recorded'), coalesce(p_only_if_source, 'nobody recorded')
      using errcode = 'SL409';
  end if;

  return replace_user_schedule(p_user_id, p_timezone, p_rules, p_source, p_expected);
end;
$$;

comment on function replace_user_schedule(uuid, text, jsonb, text, integer, text) is
  '#2702: replace_user_schedule guarded on the hours_source the caller read; raises SL409 when the locked row holds another, so an edit made during an import is never overwritten.';
