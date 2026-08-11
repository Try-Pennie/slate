-- #1315: arm/disarm the availability-truth page.
--
-- The leading half of the pair with #1313. That one notices customers already
-- being turned away; this one samples the times Slate is OFFERING and checks them
-- against live Google, so a drifted cache is caught before anyone books into it.
--
-- Same single-row config table, same precedence (store > coded default), same
-- admin form as low_volume_armed (#575) and failure_rate_armed (#1313), so there
-- is one way to arm an alert rather than three.
--
-- Nullable, and the coded default is DISARMED. Per L56 a new detector observes one
-- real cycle before it is allowed to page: the drift threshold here has never been
-- measured against real traffic, and a probe whose first live run is also its first
-- enforcing run can take the booker's reputation down over a Google blip. The issue
-- that arms it is filed in the same change (L65).
alter table monitor_alert_config
  add column availability_drift_armed boolean;
