-- #2593: arm/disarm the "a lead is booked with a team below their tier" page.
--
-- Same single-row config table, same precedence (store > coded default), same
-- admin form as low_volume_armed (#575), failure_rate_armed (#1313),
-- availability_drift_armed (#1315), roster_coverage_armed (#1454) and
-- awaiting_activation_armed (#2318), so there is one way to arm an alert.
--
-- Nullable, and the coded default is DISARMED, for the observe-first reason (L56)
-- and a sharper one: measured 2026-09-24, no real lead has an upcoming booking in
-- Slate and no Slate booking has ever carried a real Salesforce Lead id, so nobody
-- has seen one ordinary day of this check. It measures and logs every tick either
-- way, and #2696 arms it, before cutover (#65), because the cal.com Slack
-- workflow it replaces stops working then.
alter table monitor_alert_config
  add column below_lead_tier_armed boolean;
