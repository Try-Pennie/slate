-- #238: least-recently-synced ordering for the backstop sync cron. Nullable;
-- null means "never synced by the cron" and sorts first (see sync-pace.ts).
alter table public.users
  add column if not exists last_synced_at timestamptz;
