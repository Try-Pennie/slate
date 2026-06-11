-- #30: Google push notifications fired one syncByChannel per ping with no
-- coordination, so an agent editing several events in a row triggered
-- concurrent syncs of the same calendar (wasted quota, racing busy_blocks
-- writes), and overlapping cron invocations re-synced everything in parallel.
-- Cloudflare Workers isolates share no memory, so the coordination state
-- lives here: sync_pending marks "changes arrived while another request was
-- already syncing this calendar" (the holder reruns); sync_claimed_at is the
-- per-calendar claim; sync_locks holds cross-request locks (cron overlap).
alter table agent_calendars
  add column if not exists sync_pending boolean not null default false,
  add column if not exists sync_claimed_at timestamptz;

create table sync_locks (
  key        text primary key,
  claimed_at timestamptz not null
);
-- Deny-all to API clients like every other table; server uses the secret key.
alter table sync_locks enable row level security;
