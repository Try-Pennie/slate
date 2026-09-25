-- #2739: relearn the low volume floors from Slate's own bookings, once a person
-- declares the ramp over.
--
-- Same single-row config table as the floors themselves (#571) and every arming
-- switch, so the one admin page that shows the floors also holds the date that
-- changes them.
--
-- volume_ramp_end_on: the day the ramp ended, set on /admin/alerts. Nullable and
-- empty by default, and empty means NOTHING IS LEARNED: the monitor judges against
-- the cal.com measurement dated 2026-09-25 until somebody sets it. A date rather
-- than an instant, because it is a person's declaration about a day, judged in the
-- baseline's own zone (America/New_York).
--
-- volume_learning: the monitor lane's last refit, written by `runVolumeRelearn`
-- (src/lib/monitor/volume-relearn.ts) at most once a day while a ramp end is set:
-- the ramp end it was fitted for, when, and the result with its per hour floors.
-- Written by an UPDATE of this column alone, never by the settings form, so a save
-- of the other settings cannot erase it and a refit cannot move the page's "last
-- changed by" stamp. Validated field by field on every read.
alter table monitor_alert_config
  add column volume_ramp_end_on date,
  add column volume_learning jsonb;
