-- Per-agent calendar sync diagnostics (#273 Phase 1). Today a failing calendar
-- leaves no trace of WHICH agent or WHY, so the operator must hand-query the DB
-- (the exact pain that started the sync redesign). Persist per-calendar health
-- so the admin page + alerts can name the failing agent, show the streak, and
-- distinguish a transient blip from a persistent dead account.
alter table public.agent_calendars
  add column if not exists last_sync_error text,
  add column if not exists consecutive_failures int not null default 0,
  add column if not exists last_success_at timestamptz;
