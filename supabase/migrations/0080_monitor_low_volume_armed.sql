-- #575: UI-arm the low-booking-volume alert. The armed on/off switch was
-- deploy-gated (the BOOKING_VOLUME_ALERT_ARMED env var) because arming is a
-- one-time cutover decision during the cal.com to Slate ramp. Once Slate owns
-- roughly full traffic, flipping it should not require a redeploy, so it moves
-- into the same single-row monitor_alert_config store the admin settings screen
-- (#571) already edits, read with precedence store > env > coded default.
--
-- Nullable on purpose: a null (unset) column falls through to the env var and
-- then the safe coded default (DISARMED), exactly like the floors on this table.
-- Once an admin saves the settings form, an explicit true/false is written and
-- the UI wins.
alter table monitor_alert_config
  add column low_volume_armed boolean;
