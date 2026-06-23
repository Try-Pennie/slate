-- #401: durable retry queue for Google Calendar event deletions that fail
-- during cancel/reassign/create-rollback. A cron drains it; deleting an
-- already-gone event is a no-op, so retries are idempotent.
create table if not exists pending_event_deletions (
  id uuid primary key default gen_random_uuid(),
  calendar_email text not null,
  gcal_event_id  text not null,
  booking_id     uuid null references bookings(id) on delete set null,
  attempts       int  not null default 0,
  last_error     text null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index if not exists pending_event_deletions_uniq
  on pending_event_deletions (calendar_email, gcal_event_id);

create trigger set_updated_at before update on pending_event_deletions
  for each row execute function set_updated_at();

-- Default-deny like the rest of the schema: the server uses the secret key
-- (supabaseAdmin, bypasses RLS); no client ever reads this table.
alter table pending_event_deletions enable row level security;
