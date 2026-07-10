-- Rotating scan cursor for the bounded self-heal sweeps (#512).
--
-- reconcileMissingBusyBlocks (#431) and reconcileCancelledBusyBlocks (#428) each
-- scan at most a fixed page of upcoming rows per tick. At 100 to 200 agents there
-- can be more matching rows than the page, and a fixed scan only ever sees the
-- first page, so a tail row that lost (or kept a stale) busy_block would never be
-- looked at. One row per sweep holds the next offset to scan; the lane advances it
-- on a full page and wraps to 0 on a short one, so every row is covered within
-- ceil(N / page) ticks.
--
-- The selfheal lane holds a single lock, so the read-then-write is never raced.
create table selfheal_scan_cursor (
  key         text primary key,
  next_offset integer not null default 0,
  updated_at  timestamptz not null default now()
);

-- Server reads/writes via the secret-key admin client; no client access.
alter table selfheal_scan_cursor enable row level security;
