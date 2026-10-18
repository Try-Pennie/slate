-- A switch for the owner reassign notice (#2372) on /admin/alerts.
--
-- The notice tells the handoff channel that a lead's call went to the advisor they
-- have already spoken with. It was built to watch the owner reassign move while it
-- was new, and once that was seen working nobody needed it on every reassign. The
-- only way to stop it was a code change: emptying the handoff channel would also
-- silence the booking handoffs, which somebody has to act on.
--
-- It lives on the existing single-row `monitor_alert_config` (0060), beside
-- `handoff_channel`, because that row already decides where this notice goes and the
-- notice step already reads it.
--
-- NOT NULL DEFAULT false, like `calcom_retired` (0147) and unlike the nullable
-- arming switches. A null would be a third state every reader has to carry, and the
-- default is the decision that prompted this: the notice is off from the moment this
-- lands. Turning it back on is a box on the alerts page, saved through
-- `setMonitorSettings`, which audits the whole config before and after.
--
-- Read by `loadOwnerReassignNoticeOn` (src/lib/handoffs/store.ts). A failed read
-- throws, so the notice step retries rather than guessing on or off.
alter table monitor_alert_config
  add column owner_reassign_notice_on boolean not null default false;

comment on column monitor_alert_config.owner_reassign_notice_on is
  'Post the owner reassign notice (#2372) to the handoff channel. Default false: off until an admin turns it on at /admin/alerts.';
