-- UI-tunable monitor alert settings (#571). Moves the monitor's alert cooldowns,
-- low-volume floors, and Slack destinations out of compiled constants so an admin
-- can retune them without a redeploy. Read at runtime with precedence
-- store > env > coded default, so an empty store never changes behavior.
--
-- Clean split: per-alert cooldowns are genuinely keyed, so they live in a keyed
-- table; the odd-ones-out (two low-volume floors + two global Slack channels) are
-- singletons, so they live on a single-row config table. No polymorphic/sentinel
-- rows.

-- Per-alert cooldowns, keyed by the same alert key the cron uses for alert_state
-- (availability_data_anomaly, availability_booked_solid, fallback_covered_availability,
-- low_booking_volume). A missing row means "use the coded default".
create table monitor_settings (
  key          text primary key,
  cooldown_min integer,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references users(id) on delete set null
);

-- Global monitor config, a single row (id is pinned to 1). Null column = unset =
-- fall through to env then coded default. alerts_channel/info_channel become the
-- app-wide default Slack destinations for ALL alerts (not just the monitor's).
create table monitor_alert_config (
  id             smallint primary key default 1 check (id = 1),
  floor_30       integer,
  floor_120      integer,
  alerts_channel text,
  info_channel   text,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references users(id) on delete set null
);

-- Server reads/writes via the secret-key admin client; no client access.
alter table monitor_settings enable row level security;
alter table monitor_alert_config enable row level security;
