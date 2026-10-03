-- Two concurrency fixes that both need a column (#3118, #3122). Additive only:
-- applied before the code that reads it deploys, the deployed code keeps working,
-- because nothing it sends names these columns or this function.
--
-- ## #3118: a slot compute that straddles a settings save
--
-- An admin save marks every `bucket_slots` row stale by back dating `computed_at`
-- to the epoch. A compute that STARTED before the save read the old settings, and
-- its stamp (the compute start) is newer than the epoch, so the write gate let it
-- land over the stale mark. The row then looked fresh for the whole freshness
-- window while offering times under the old settings.
--
-- `invalidated_at` is the high water mark the save now records beside the back
-- dated stamp. The slot write refuses any compute that began at or before it, so
-- the row stays due and the next tick rebuilds it. Nullable: a row nobody has
-- invalidated carries null, which the gate reads as "nothing to refuse", and that
-- is also what every existing row holds once this is applied.
alter table public.bucket_slots
  add column if not exists invalidated_at timestamptz;

comment on column public.bucket_slots.invalidated_at is
  '#3118: when a settings save last marked this row stale. A slot write whose compute began at or before this instant is refused.';

-- ## #3122: admin and agent edits were last write wins
--
-- The event type editors and the working hours forms wrote with no version check,
-- so two people editing at once silently overwrote each other. Each form now sends
-- back the `updated_at` it loaded, and the write only lands when the row still
-- holds it. Neither table had the column, so it is added here with the existing
-- `set_updated_at` trigger (migration 0001) that every other versioned table uses.
--
-- The default fills every existing row with the apply time, which is a value no
-- open form holds yet; a form opened before the deploy carries no stamp at all and
-- is refused by the code as out of date, never matched by accident.
alter table public.event_types
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists event_types_updated_at on public.event_types;
create trigger event_types_updated_at before update on public.event_types
  for each row execute function set_updated_at();

-- The schedule row is the version of the WEEK, not only of the zone: every write
-- of a week goes through `replace_user_schedule`, whose upsert updates this row
-- (an ON CONFLICT DO UPDATE fires the BEFORE UPDATE trigger) and whose
-- `replace_availability_rules` stamps `hours_source` on it, so a change to the
-- rules alone still moves this stamp.
alter table public.availability_schedules
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists availability_schedules_updated_at on public.availability_schedules;
create trigger availability_schedules_updated_at before update on public.availability_schedules
  for each row execute function set_updated_at();

-- The guarded week write. A separate NAME rather than another overload of
-- `replace_user_schedule`, so PostgREST can never resolve a call to the wrong form.
-- It locks the agent's schedule row, compares its `updated_at` against the one the
-- form loaded, and raises SQLSTATE SL409 (the code migration 0157 uses for the
-- same meaning, "the row changed underneath you") before anything is written.
--
-- A null `p_loaded_updated_at` means the form was drawn with NO schedule row, so a
-- row that has since appeared is a change too. The compare is `is distinct from`
-- for that reason. The lock is `for update`, the same lock the write's upsert
-- takes, so a save that commits first is seen here and a second one waits, then
-- finds the stamp moved and refuses.
--
-- The write itself delegates to the five argument form, so there is still ONE
-- place that replaces a week, and the guard and the write share one transaction.
--
-- search_path is pinned per the repo rule. Everything it touches is in `public`
-- and it calls no extension function, so the pin reaches all of it (#1126).
create or replace function replace_user_schedule_if_unchanged(
  p_user_id            uuid,
  p_timezone           text,
  p_rules              jsonb,
  p_source             text,
  p_expected           integer,
  p_loaded_updated_at  timestamptz
) returns integer
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_current timestamptz;
begin
  select updated_at
    into v_current
    from availability_schedules
   where user_id = p_user_id
   for update;

  if v_current is distinct from p_loaded_updated_at then
    raise exception
      'replace_user_schedule_if_unchanged: the hours for user % were saved by somebody else after this form was opened; nothing has been saved',
      p_user_id
      using errcode = 'SL409';
  end if;

  return replace_user_schedule(p_user_id, p_timezone, p_rules, p_source, p_expected);
end;
$$;

comment on function replace_user_schedule_if_unchanged(uuid, text, jsonb, text, integer, timestamptz) is
  '#3122: replace_user_schedule guarded on the updated_at the form loaded; raises SL409 when the locked row holds another, so two editors cannot silently overwrite each other.';
