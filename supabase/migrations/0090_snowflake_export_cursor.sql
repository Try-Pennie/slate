-- Resumable watermark for the Snowflake archival mirror export lane (#1098).
--
-- The export lane (#1099) reads each mirrored table in created_at / updated_at
-- order and MERGEs it into Snowflake, advancing a watermark only after a
-- confirmed terminal Snowflake response. That watermark has to survive across
-- ticks and across a crash, so it lives here rather than in memory.
--
-- One row per (lane, table). `key` is the scope: the incremental lane uses the
-- bare table name (e.g. 'bookings'); the backfill lane (#1100) uses a distinct
-- prefix (e.g. 'backfill:bookings') so the two never fight over one watermark.
-- Modeled on selfheal_scan_cursor (migration 0064), which also keys a resumable
-- cursor by an opaque text `key`.
--
-- last_ts holds the value of whichever column drives that table: created_at for
-- the append-only tables (booking_events, audit_log, routing_decisions, which
-- cannot take an exported_at stamp because the 0089 triggers block UPDATE), and
-- updated_at for the mutable tables (bookings, webhook_deliveries, booking_outbox).
-- last_id is the row id at that timestamp, so a keyset read can break ties when
-- several rows share a timestamp (avoids skipping or re-reading at the boundary).
-- Both are null until the first successful export for that key.
create table export_cursor (
  key        text primary key,
  last_ts    timestamptz,
  last_id    uuid,
  updated_at timestamptz not null default now()
);

-- Server reads/writes via the secret-key admin client; no client access.
alter table export_cursor enable row level security;
