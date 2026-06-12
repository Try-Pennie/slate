-- Out-of-office requests (port of the Apps Script OOO workflow).
-- Agents request time off; their manager (or an admin) approves/rejects in
-- Slate. Approval creates Google Calendar events and a busy_blocks write-through
-- so availability blocks immediately; ids of every created artifact are stored
-- on the row so cancel/modify can undo deterministically.

-- Agent -> manager edge (the Apps Script kept this in the People sheet).
-- Admin-edited; the Salesforce sync never touches it.
alter table users add column manager_id uuid references users(id) on delete set null;
-- Set on manager rows: the manager's "OOO" Google calendar that approval
-- events land on (replaces the hardcoded manager->calendar map).
alter table users add column ooo_calendar_id text;
create index users_manager_idx on users(manager_id);

create table ooo_requests (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references organizations(id) on delete cascade,
  user_id                   uuid not null references users(id) on delete cascade,
  -- Manager snapshot at submit time (reassignments don't reroute old requests).
  manager_id                uuid references users(id) on delete set null,
  starts_at                 timestamptz not null,
  ends_at                   timestamptz not null,
  -- The tz the agent submitted in; every notification renders times in it.
  display_tz_id             text not null default 'America/New_York',
  display_tz_label          text not null default 'ET',
  reason                    text not null,
  notes                     text,
  status                    text not null default 'pending'
                              check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  rejection_note            text,
  decided_by                uuid references users(id) on delete set null,
  decided_at                timestamptz,
  cancelled_at              timestamptz,
  -- Post-approval artifacts, stored for deterministic undo.
  manager_event_id          text,
  manager_event_calendar_id text,
  agent_event_id            text,
  busy_block_id             uuid references busy_blocks(id) on delete set null,
  calcom_synced             boolean not null default false,
  -- Per-effect outcome map ({ manager_event: "ok" | "failed: ...", ... }).
  side_effects              jsonb not null default '{}',
  -- Sheet request_id for the one-time import (idempotent re-runs).
  legacy_request_id         text unique,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index ooo_requests_org_status_idx on ooo_requests(org_id, status, starts_at);
create index ooo_requests_user_idx on ooo_requests(user_id, created_at desc);
create index ooo_requests_manager_pending_idx on ooo_requests(manager_id, status);
-- Duplicate rule from the Apps Script (checkDuplicateRequest_): one active
-- (pending/approved) request per agent + exact window, enforced race-proof.
create unique index ooo_requests_active_dupe_idx
  on ooo_requests(user_id, starts_at, ends_at)
  where status in ('pending', 'approved');

create trigger ooo_requests_updated_at before update on ooo_requests
  for each row execute function set_updated_at();

-- Deny-all to API clients; all server access is via the secret key.
alter table ooo_requests enable row level security;
