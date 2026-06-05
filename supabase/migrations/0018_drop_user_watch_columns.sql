-- The per-user calendar watch/sync columns are dead: multi-calendar sync (#7)
-- moved this state to agent_calendars, and that code is now live in prod (every
-- agent's calendars are watched/synced there). Drop them (#18).
alter table users
  drop column if exists sync_token,
  drop column if exists watch_channel_id,
  drop column if exists watch_resource_id,
  drop column if exists watch_expiration;
