-- Slate initial schema.
-- Tenant-aware (org_id everywhere) for a single org today, multi-tenant later.
-- Server code uses the service-role key (bypasses RLS) for all privileged
-- reads/writes; RLS is default-deny with a single self-select policy on `users`.

create extension if not exists "pgcrypto";

-- Keeps updated_at fresh on tables that opt in via trigger.
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Organizations & users
-- ---------------------------------------------------------------------------
create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table users (
  id          uuid primary key references auth.users(id) on delete cascade,
  org_id      uuid not null references organizations(id) on delete cascade,
  email       text not null unique,
  name        text,
  role        text not null default 'agent' check (role in ('admin', 'agent')),
  google_sub  text,
  created_at  timestamptz not null default now()
);
create index users_org_idx on users(org_id);

-- Per-agent Google Calendar connection + sync state.
create table google_credentials (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null unique references users(id) on delete cascade,
  access_token     text,
  refresh_token    text,
  token_expiry     timestamptz,
  calendar_id      text not null default 'primary',
  watch_channel_id text,
  watch_resource_id text,
  watch_expiration timestamptz,
  sync_token       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger google_credentials_updated_at before update on google_credentials
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Event types & buckets (round-robin pools)
-- ---------------------------------------------------------------------------
create table event_types (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  name              text not null,            -- the eventTitle, e.g. "Senior Loan Advisor Call"
  description       text,                     -- shown to the lead + sent as Regal `description`
  regal_type        text not null default 'call', -- the Regal `type` slug
  duration_min      int not null default 30,
  buffer_before_min int not null default 0,
  buffer_after_min  int not null default 0,
  min_notice_min    int not null default 120,
  daily_cap         int,                       -- null = unlimited per agent/day
  slot_interval_min int not null default 15,
  created_at        timestamptz not null default now()
);
create index event_types_org_idx on event_types(org_id);

create table buckets (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references organizations(id) on delete cascade,
  code                     text not null,       -- e.g. the "411" in ?xbc=411
  name                     text not null,
  event_type_id            uuid not null references event_types(id),
  assignment               text not null default 'round_robin'
                             check (assignment in ('round_robin')),
  rr_last_assigned_user_id uuid references users(id),
  created_at               timestamptz not null default now(),
  unique (org_id, code)
);

create table bucket_members (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  uuid not null references buckets(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  weight     int not null default 1,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (bucket_id, user_id)
);
create index bucket_members_bucket_idx on bucket_members(bucket_id);

-- ---------------------------------------------------------------------------
-- Working hours
-- weekday: 1=Mon .. 7=Sun (Luxon convention). Minutes are local to `timezone`.
-- ---------------------------------------------------------------------------
create table availability_schedules (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  timezone   text not null default 'America/New_York',
  created_at timestamptz not null default now()
);
create index availability_schedules_user_idx on availability_schedules(user_id);

create table availability_rules (
  id           uuid primary key default gen_random_uuid(),
  schedule_id  uuid not null references availability_schedules(id) on delete cascade,
  weekday      int not null check (weekday between 1 and 7),
  start_minute int not null check (start_minute between 0 and 1440),
  end_minute   int not null check (end_minute between 0 and 1440),
  check (end_minute > start_minute)
);
create index availability_rules_schedule_idx on availability_rules(schedule_id);

-- ---------------------------------------------------------------------------
-- Busy store: the cached availability index.
--   source='slate' -> written synchronously when Slate books (write-through)
--   source='gcal'  -> mirror of external Google events, kept fresh by sync
-- ---------------------------------------------------------------------------
create table busy_blocks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  source        text not null check (source in ('slate', 'gcal')),
  gcal_event_id text,
  booking_id    uuid,
  created_at    timestamptz not null default now()
);
create index busy_blocks_user_window_idx on busy_blocks(user_id, starts_at, ends_at);
-- One row per external gcal event, so sync can upsert/delete by id.
create unique index busy_blocks_gcal_event_idx
  on busy_blocks(user_id, gcal_event_id) where gcal_event_id is not null;

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------
create table bookings (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  bucket_id        uuid not null references buckets(id),
  event_type_id    uuid not null references event_types(id),
  assigned_user_id uuid not null references users(id),
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  timezone         text not null,             -- attendee timezone
  status           text not null default 'confirmed'
                     check (status in ('confirmed', 'rescheduled', 'cancelled', 'completed')),
  salesforce_id    text,                       -- opaque id from the booking URL path
  attendee_name    text,
  attendee_email   text,
  attendee_phone   text,
  prefill          jsonb not null default '{}'::jsonb,
  gcal_event_id    text,
  manage_token     text not null unique,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index bookings_assigned_idx on bookings(assigned_user_id, starts_at);
create index bookings_bucket_idx on bookings(bucket_id);
create trigger bookings_updated_at before update on bookings
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Webhooks (consumed by Regal/Cadence)
-- ---------------------------------------------------------------------------
create table webhook_endpoints (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  url         text not null,
  secret      text not null,
  events      text[] not null default array[
                'booking.created', 'booking.rescheduled',
                'booking.cancelled', 'booking.completed'],
  -- 'generic' = {event,data} body signed with HMAC (x-slate-signature).
  -- 'regal'   = Regal event shape, sent with Authorization: <auth_header>.
  format      text not null default 'generic' check (format in ('generic', 'regal')),
  auth_header text,
  active       boolean not null default true,
  created_at  timestamptz not null default now()
);

create table webhook_deliveries (
  id            uuid primary key default gen_random_uuid(),
  endpoint_id   uuid not null references webhook_endpoints(id) on delete cascade,
  event         text not null,
  payload       jsonb not null,
  status        text not null default 'pending'
                  check (status in ('pending', 'success', 'failed')),
  attempts      int not null default 0,
  last_response text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index webhook_deliveries_status_idx on webhook_deliveries(status);
create trigger webhook_deliveries_updated_at before update on webhook_deliveries
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: default-deny. Server code uses the service-role key and bypasses this.
-- The only client-side read we allow is a signed-in user reading their own row.
-- ---------------------------------------------------------------------------
alter table organizations         enable row level security;
alter table users                 enable row level security;
alter table google_credentials    enable row level security;
alter table event_types           enable row level security;
alter table buckets               enable row level security;
alter table bucket_members        enable row level security;
alter table availability_schedules enable row level security;
alter table availability_rules    enable row level security;
alter table busy_blocks           enable row level security;
alter table bookings              enable row level security;
alter table webhook_endpoints     enable row level security;
alter table webhook_deliveries    enable row level security;

create policy "self can read own user row" on users
  for select using (id = auth.uid());
