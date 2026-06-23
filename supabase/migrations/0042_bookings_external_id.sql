-- The direct booking API (#357) stores the external caller's stable per-person
-- id, so a returning lead is recognized across calls and the bot can correlate
-- a booking back to its lead. Nullable: embed/human bookings carry no
-- external_id and are matched by identity (salesforce_id, or email+phone).
alter table bookings add column if not exists external_id text;

-- Person lookups find an existing ACTIVE appointment by external_id; index just
-- the active rows (mirrors the idempotency / active-slot partial-index pattern,
-- migrations 0009/0010). NOT unique: the same lead legitimately has historical
-- cancelled/completed rows with the same external_id.
create index if not exists bookings_external_id_active_idx
  on bookings (external_id)
  where external_id is not null and status in ('confirmed', 'rescheduled');
