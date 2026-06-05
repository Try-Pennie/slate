-- Append-only audit trail of privileged actions (role changes + manager/admin
-- edits to agents) for accountability and incident review (#28).
create table audit_log (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  actor_id    uuid references users(id) on delete set null,
  action      text not null,
  target_id   uuid references users(id) on delete set null,
  details     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index audit_log_org_idx on audit_log(org_id, created_at desc);

-- Deny-all to API clients (no policy); server reads/writes via the secret key.
alter table audit_log enable row level security;
