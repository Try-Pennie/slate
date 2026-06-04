-- Persistent cooldown state for outbound alerts. The sync cron runs every
-- minute; without this a persistent watch lapse would post to Slack every run.
-- Keyed by alert name (e.g. 'watch_lapse'); the cron checks last_sent_at against
-- a cooldown before posting and upserts it after.
create table if not exists alert_state (
  key          text primary key,
  last_sent_at timestamptz not null default now()
);
