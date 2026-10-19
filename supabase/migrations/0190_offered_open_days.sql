-- #3922: how many open business days every lead is offered becomes a stored setting.
--
-- It was the constant OFFERED_OPEN_DAYS = 3 in src/lib/availability/bookable-days.ts
-- (#2840), and Dan asked to change it on the Hours page himself, without a deploy.
-- It lives on the existing single-row booking_settings (0086), beside horizon_days
-- (0087), because the two are edited together on one card and the last resort's
-- reach is stored as offered plus extra in horizon_days, which every existing reader
-- of the horizon keeps reading unchanged.
--
-- NOT NULL DEFAULT 3, which is the value production runs on today, so nothing a lead
-- sees changes when this lands. Nothing writes it except an admin saving the Days
-- offered card (setDaysOffered), which audits the save. The CHECK is the same 1 to 7
-- the server enforces: 7 is the ceiling availability is computed to.
--
-- Read by readDaysOffered (src/lib/booking/days-offered-load.ts). A failed read is
-- never replaced by a default: the booker keeps the last value it read, a measuring
-- caller reports that it could not measure.
alter table booking_settings
  add column offered_open_days smallint not null default 3
    check (offered_open_days between 1 and 7);

comment on column booking_settings.offered_open_days is
  'How many open business days every lead is offered (#3922). Default 3. The last resort reach stays in horizon_days as offered plus extra. Edited on /admin/business-hours.';
