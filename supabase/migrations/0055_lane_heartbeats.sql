-- Dead-man's switch for the monitor lane (#420): each monitor tick stamps its
-- last-ran time here; the sync lane (which runs every minute) checks it and
-- alerts if it's stale (>15 min = 3 missed 5-min ticks).

create table lane_heartbeats (
  lane        text primary key,
  last_ran_at timestamptz not null default now()
);

-- Server reads/writes via the secret-key admin client; no client access.
alter table lane_heartbeats enable row level security;
