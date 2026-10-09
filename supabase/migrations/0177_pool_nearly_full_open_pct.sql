-- #3559: the nearly full pool line becomes a setting.
--
-- The pool_nearly_full notice now judges the days the booker shows a lead, added
-- up, rather than today alone, and names a pool when fewer than this percentage
-- of its possible starts across those days are still open. It was a constant
-- (10%); Dan, 2026-10-09, asked for it on /admin/alerts.
--
-- Same single-row config table and the same precedence as the other monitor
-- settings (store > coded default). Nullable: null means the coded 10, so applying
-- this changes nothing until somebody edits /admin/alerts. The resolver refuses a
-- stored value outside 1 to 50 and falls back to the default. The code reading
-- this column must deploy AFTER this is applied.
alter table monitor_alert_config
  add column pool_nearly_full_open_pct integer;
