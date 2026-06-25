-- #436 / #429 P1: make webhook delivery exactly-once.
-- A re-enqueue of the same logical booking event (a retry, or the future outbox
-- executor) must not insert a second delivery row or POST Regal/Cadence twice.
-- A partial UNIQUE on (endpoint_id, event, dedupe_key) is the guard: an insert
-- with a duplicate key hits 23505 and the caller skips the send. Legacy rows and
-- any delivery without a derivable key keep dedupe_key NULL — the partial index
-- ignores them, so they behave exactly as before (at-least-once).

alter table webhook_deliveries add column if not exists dedupe_key text;

create unique index if not exists webhook_deliveries_dedupe_uniq
  on webhook_deliveries (endpoint_id, event, dedupe_key)
  where dedupe_key is not null;
