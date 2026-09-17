-- #2366: record WHEN public booking was stopped, so a switch left on can be noticed.
--
-- The #2297 kill switch is a single boolean, and a boolean cannot say how long it has
-- been true. The failure it leaves open is the ordinary one: somebody stops bookings
-- at 2am to contain a problem, fixes the problem, and does not flip it back. Slate
-- then takes zero bookings while every other signal reads healthy. What eventually
-- notices is the low booking volume alarm, and it reports a drought, sending whoever
-- reads it after a funnel problem that does not exist.
--
-- WHY A COLUMN OF ITS OWN, and not `updated_at`. That stamp is shared with the other
-- columns on this single settings row, so editing the booking horizon or the default
-- bucket would push the pause clock forward and the notice would never fire. The
-- elapsed time has to be measured from when the FLAG was set, never from when a
-- monitor first noticed it, or a deploy or a lane restart resets the count (L457).
--
-- WHY A TRIGGER, and not the admin action that flips the switch. Three writers reach
-- this column and only one of them is that action: `pnpm verify:kill-switch` writes
-- it twice on every scheduled run, and hand SQL is the documented remedy when the
-- admin page is the thing that is broken. A stamp each writer has to opt into is a
-- stamp the next writer forgets (L621), so it is maintained at the layer every path
-- shares (L593). The trigger also makes it idempotent, which the action cannot be on
-- its own: the control posts the STATE it wants rather than toggling, so two admins
-- reacting to one incident both press stop, and a writer that set the stamp
-- unconditionally would restart the clock every time somebody pressed it again.
--
-- NULLABLE, and null has exactly one meaning: booking is not stopped. A paused row
-- with a null stamp is only reachable from a database that predates this migration
-- or from a hand write with the trigger dropped, and the monitor speaks about that
-- case rather than waiting out a clock that does not exist.

alter table booking_settings
  add column public_booking_paused_at timestamptz;

comment on column booking_settings.public_booking_paused_at is
  'The #2366 stamp: when public_booking_paused last went from false to true. Null while booking is running. Maintained by booking_settings_stamp_pause, never written by application code.';

-- The backfill runs BEFORE the trigger exists, deliberately. The trigger below
-- preserves an existing stamp across an update that leaves the flag paused, so
-- creating it first would make this statement a no-op.
--
-- now(), not updated_at, for a row that is currently paused. This cannot know when
-- the switch was thrown, and updated_at may have been moved by an unrelated edit to
-- the same row, so the honest conservative choice is to start the clock here: it
-- delays a first notice by at most the threshold rather than firing one immediately
-- about a duration nobody measured (L440).
update booking_settings
  set public_booking_paused_at = now()
  where public_booking_paused
    and public_booking_paused_at is null;

create or replace function booking_settings_stamp_pause()
  returns trigger
  language plpgsql
  -- Pinned like every other Slate function. now() is a pg_catalog built in, which
  -- Postgres always searches, so the pin cannot make it unreachable (#1125).
  set search_path = public
as $$
begin
  if new.public_booking_paused then
    if tg_op = 'UPDATE' and old.public_booking_paused then
      -- Already stopped and still stopped: the clock keeps running from the FIRST
      -- stop. Assigning old's value rather than leaving new's alone also makes the
      -- column unwritable by hand, so there is one writer rather than two.
      new.public_booking_paused_at := old.public_booking_paused_at;
    else
      new.public_booking_paused_at := now();
    end if;
  else
    new.public_booking_paused_at := null;
  end if;
  return new;
end;
$$;

comment on function booking_settings_stamp_pause() is
  'Maintains booking_settings.public_booking_paused_at (#2366): stamps the transition into paused, keeps the first stamp while it stays paused, and clears it when booking starts again.';

create trigger booking_settings_stamp_pause
  before insert or update on booking_settings
  for each row execute function booking_settings_stamp_pause();
