-- #3227: when a debt tier's "offering no times" page may end.
--
-- The page fires when a tier offers no booking time before the end of the next
-- open business day, and its all clear used to go out the first tick the tier
-- offered even one. An all clear also resets the cooldown, so on a full day one
-- cancelled call booked again minutes later paged, cleared and paged again
-- (Low, 2026-10-04). The all clear now waits until the tier offers at least
-- empty_tier_recovery_min_times open times and has held that for
-- empty_tier_recovery_hold_min minutes. Paging is unchanged.
--
-- Same single-row config table and the same precedence as the other monitor
-- settings (store > coded default). Nullable: null means the coded default,
-- 3 times and 30 minutes, so applying this changes nothing until somebody edits
-- /admin/alerts. The code reading these columns must deploy AFTER this is applied.
alter table monitor_alert_config
  add column empty_tier_recovery_min_times integer,
  add column empty_tier_recovery_hold_min integer;
