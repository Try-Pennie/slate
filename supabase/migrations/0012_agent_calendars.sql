-- Per-calendar sync + push state, so Slate can watch and incrementally sync
-- ALL of an agent's calendars (not just primary) and never book over a block
-- on a secondary calendar. Replaces the per-user watch/sync columns on `users`
-- (those are left in place, now unused, to keep the code deploy-order-safe;
-- they can be dropped in a later cleanup once the new code is live).
create table if not exists agent_calendars (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(id) on delete cascade,
  calendar_id       text not null,
  sync_token        text,
  watch_channel_id  text,
  watch_resource_id text,
  watch_expiration  timestamptz,
  created_at        timestamptz not null default now(),
  unique (user_id, calendar_id)
);

-- Resolve an incoming Google push (by channel id) back to the calendar row.
create index if not exists agent_calendars_watch_channel_idx
  on agent_calendars(watch_channel_id) where watch_channel_id is not null;
