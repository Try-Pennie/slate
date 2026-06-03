-- With domain-wide delegation, calendar access no longer needs per-agent OAuth
-- tokens — Slate impersonates each agent by email. We still track incremental
-- sync + watch-channel state per agent, so move it onto the users row (synced
-- agents never have a google_credentials row).
alter table users add column sync_token text;
alter table users add column watch_channel_id text;
alter table users add column watch_resource_id text;
alter table users add column watch_expiration timestamptz;

-- Backfill from existing google_credentials (the admin who connected via OAuth).
update users u set
  sync_token = g.sync_token,
  watch_channel_id = g.watch_channel_id,
  watch_resource_id = g.watch_resource_id,
  watch_expiration = g.watch_expiration
from google_credentials g
where g.user_id = u.id;
