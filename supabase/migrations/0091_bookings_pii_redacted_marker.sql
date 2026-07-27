-- #1118 (Phase 7 of the #1029 PII/compliance milestone): mark a booking whose
-- contact PII has been redacted in place, so the Snowflake mirror stops fighting
-- the redaction.
--
-- bookings + webhook_deliveries are exported keyed on `updated_at`, and redacting
-- a row bumps `updated_at` (the `set_updated_at` trigger). Without a marker the
-- export lane re-MERGEs the blanked row over Snowflake's full-fidelity copy (the
-- clobber the mirror exists to avoid), and the count reconcile miscounts an
-- erased-before-export row as permanent drift. This column is the signal both the
-- export fetch and the reconcile count filter on (src/lib/snowflake/skip-redacted.ts).
--
-- Both redaction paths stamp it: the #1071 retention cron (REDACTED_BOOKING_UPDATE)
-- and the #1072 erasure function (migration 0092). NULL = not redacted = exported
-- and counted normally, so every existing row is unaffected on deploy.
alter table bookings
  add column if not exists pii_redacted_at timestamptz;

comment on column bookings.pii_redacted_at is
  'When the booking''s contact PII was redacted in place (#1071 retention / #1072 erasure). Non-null rows are frozen out of the Snowflake export and the reconcile count (#1118).';

-- The export fetch is a keyset over (updated_at, id) FILTERED to un-redacted rows.
-- Serve exactly that shape at the 200-agent design target. Partial, so the index
-- only spans live (un-redacted) rows and stays small.
create index if not exists bookings_export_keyset_idx
  on bookings (updated_at, id)
  where pii_redacted_at is null;

-- The webhook export fetch is the analogous filtered keyset (payload_erased=false,
-- the #1073 blank marker). No index existed for it before (#1118).
create index if not exists webhook_deliveries_export_keyset_idx
  on webhook_deliveries (updated_at, id)
  where payload_erased = false;
