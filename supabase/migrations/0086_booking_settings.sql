-- #1015: direct-booking settings. Phase 1 of #541 (the validate-only "is this
-- time bookable?" endpoint). A keyed direct-booking caller may pass no XBC; when
-- it doesn't, Slate routes to an admin-configured default bucket. That default
-- was nowhere to live, so this adds a single-row config table for it, following
-- the monitor_alert_config (0060) singleton precedent.
--
-- Global (no org_id): Slate is single-org, matching monitor_settings (0060) and
-- reason_options (0084). id is pinned to 1 so there is exactly one row; the admin
-- settings screen (#1016) upserts it. No seed row: an unset default reads back as
-- null (maybeSingle -> null), and the bookable endpoint (#1017) fails loud with
-- NO_DEFAULT_BUCKET rather than guessing a bucket.
create table booking_settings (
  id                  smallint primary key default 1 check (id = 1),
  default_bucket_code text,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references users(id) on delete set null
);

-- Server reads/writes via the secret-key admin client; no client access.
alter table booking_settings enable row level security;
