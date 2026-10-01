-- #2890: cal.com blocks left behind while cal.com was retired, so putting it back
-- can take them out.
--
-- WHY. While `monitor_alert_config.calcom_retired` is true (#2875) the time off
-- dual write writes nothing to cal.com, in BOTH directions. An absence approved
-- while cal.com was live has a block there; cancelling or changing it while
-- cal.com is retired skips the removal, and the request row then forgets the
-- window: a cancellation sets `calcom_synced` false, and a change replaces
-- `starts_at` / `ends_at` with the new window. So once an admin puts cal.com back,
-- nothing knows that cal.com still holds a block for days the agent is working.
--
-- WHAT A ROW HOLDS. The window cal.com still blocks, the request and agent it
-- belonged to, the outcome that left it behind, and the outcome of the latest
-- attempt to take it out. The override sweep (monitor lane) works through the
-- unresolved rows once cal.com is live, rewriting those dates from the agent's
-- CURRENT approved time off (the same derivation every writer uses, #2417), and
-- stamps `resolved_at` when that lands. A row is the record of a window, not of a
-- request, which is why it is its own table: a request changed twice while cal.com
-- was retired leaves two windows, and the request row can only hold one.
--
-- UNIQUE on (request_id, starts_at, ends_at), so recording the same window twice
-- (a retried cancel) is one row, and a window that goes stale again after it was
-- resolved reopens that row rather than adding a second (the writer upserts and
-- clears `resolved_at`).
--
-- Small by construction: only cancellations and changes made while cal.com was
-- retired write here. Not mirrored to Snowflake: it holds no contact data and no
-- fact the warehouse needs, only a work queue.
create table calcom_override_removals (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references ooo_requests(id) on delete cascade,
  -- The agent, for their cal.com address. Cascades with the user like the request
  -- itself does: somebody deleted from Slate cannot be booked by anyone.
  user_id     uuid not null references users(id) on delete cascade,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  -- The removal outcome that left the block behind, e.g. "skipped: cal.com retired".
  reason      text not null,
  -- The latest attempt to take it out, null until one runs.
  last_outcome text,
  created_at  timestamptz not null default now(),
  -- When the block was taken out. Null while cal.com still holds it.
  resolved_at timestamptz,
  constraint calcom_override_removals_window_order check (ends_at > starts_at)
);

-- One row per (request, window), non partial so the writer's upsert can target it.
create unique index calcom_override_removals_window_key
  on calcom_override_removals (request_id, starts_at, ends_at);

-- The sweep's and the put back count's read: unresolved windows that have not ended.
create index calcom_override_removals_open_idx
  on calcom_override_removals (ends_at)
  where resolved_at is null;

-- Server reads and writes through the secret key client only; no client access.
alter table calcom_override_removals enable row level security;

comment on table calcom_override_removals is
  'The #2890 queue of cal.com blocks left behind when time off was cancelled or changed while cal.com was retired. The override sweep takes each out once cal.com is live and stamps resolved_at.';
