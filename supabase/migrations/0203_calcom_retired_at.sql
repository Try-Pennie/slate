-- #3896: record WHEN cal.com was marked retired, so the low volume anchor can retire
-- a set time after it.
--
-- The learned low volume floors are held at or above each tier's cal.com measurement,
-- thinned to the share Slate carries (#2893). After cutover cal.com carries nothing,
-- the share is 1 for good, and the anchor would be the tier's whole cal.com volume for
-- ever: a deliberate traffic cut to Medium, High or Very High (which have no floor
-- override) would page every day. Dan decided on 2026-10-23 that the anchor retires a
-- set time after cutover (`ANCHOR_OVERLAP_WEEKS` in src/lib/monitor/volume-relearn.ts),
-- and that time has to be measured from somewhere stored. `calcom_retired` (0147) is
-- the record that cutover happened, but a boolean cannot say since when.
--
-- WHY A COLUMN OF ITS OWN, and not `updated_at`: that stamp is shared with every
-- other setting on this single row, so saving a cooldown would move the date.
--
-- WHY A TRIGGER, the 0132 pattern (`public_booking_paused_at`): the stamp is kept at
-- the layer every writer shares (L593), including hand SQL, and it is idempotent. The
-- switch posts the STATE it wants, so pressing "retire" again while retired must not
-- restart the clock. Unlike 0132, an explicit value written while cal.com stays
-- retired is KEPT, so an admin or a migration can correct the date to the day the
-- last landing page really moved; it can never be cleared while retired.
--
-- It also leaves the deployed code working before the code that reads it ships: the
-- current `setCalcomRetired` never names the column, and the trigger fills it.
--
-- NULLABLE, and null has exactly one meaning: cal.com is not marked retired. The
-- reader treats a date that does not parse the same way, which keeps the anchor.

alter table monitor_alert_config
  add column calcom_retired_at timestamptz;

comment on column monitor_alert_config.calcom_retired_at is
  'The #3896 stamp: when calcom_retired last went from false to true. Null while cal.com is live. Maintained by monitor_alert_config_stamp_calcom_retired; the low volume anchor retires ANCHOR_OVERLAP_WEEKS after it.';

-- The backfill runs BEFORE the trigger exists, like 0132's. A row already retired gets
-- the time of the audit entry that retired it (the latest one that moved the switch
-- to true from anything but true), or now() when there is none, the conservative
-- choice: it starts the overlap here rather than retiring the anchor on a date
-- nobody recorded.
update monitor_alert_config c
  set calcom_retired_at = coalesce(
    (
      select max(a.created_at)
      from audit_log a
      where a.action = 'monitor.calcom_retired'
        and a.details ->> 'to' = 'true'
        and coalesce(a.details ->> 'from', 'null') <> 'true'
    ),
    now()
  )
  where c.calcom_retired
    and c.calcom_retired_at is null;

create or replace function monitor_alert_config_stamp_calcom_retired()
  returns trigger
  language plpgsql
  -- Pinned like every other Slate function. now() and coalesce are pg_catalog built
  -- ins, which Postgres always searches, so the pin cannot make them unreachable.
  set search_path = public
as $$
begin
  if new.calcom_retired then
    if tg_op = 'UPDATE' and old.calcom_retired then
      -- Still retired: keep the first stamp unless a writer names a new one.
      new.calcom_retired_at := coalesce(new.calcom_retired_at, old.calcom_retired_at, now());
    else
      -- The move into retired: stamped now unless the same write names the date.
      -- An update that does not name the column carries old's value, which is null
      -- while cal.com is live, so the stamp is now().
      new.calcom_retired_at := coalesce(new.calcom_retired_at, now());
    end if;
  else
    new.calcom_retired_at := null;
  end if;
  return new;
end;
$$;

comment on function monitor_alert_config_stamp_calcom_retired() is
  'Maintains monitor_alert_config.calcom_retired_at (#3896): stamps the move into retired, keeps the stamp (or an explicit correction) while it stays retired, and clears it when cal.com is put back.';

create trigger monitor_alert_config_stamp_calcom_retired
  before insert or update on monitor_alert_config
  for each row execute function monitor_alert_config_stamp_calcom_retired();
