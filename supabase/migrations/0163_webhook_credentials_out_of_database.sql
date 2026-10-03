-- #3091, the contract half: the outbound webhook credentials leave the database.
--
-- webhook_endpoints.auth_header held the Regal API key and webhook_endpoints.secret
-- the HMAC signing secret, in plaintext, so anyone who could read the table (a
-- leaked service key, a backup copy, a SQL editor session) held the key that
-- authenticates every booking event to Regal. Dan decided on 2026-10-03 that both
-- live in Worker secrets instead (REGAL_WEBHOOK_KEY, WEBHOOK_SIGNING_SECRET).
--
-- The expand half shipped first: the code read the Worker secret and fell back to
-- these columns, logged which one each delivery used, and paged
-- webhook_credentials_in_database while it was the column. APPLY THIS ONLY ONCE
-- BOTH SECRETS ARE PUT AND THAT ALERT HAS CLEARED. The code shipping with this
-- migration reads the Worker alone, and a delivery whose secret is unset is
-- refused rather than sent unauthenticated or unsigned.
--
-- The columns are nulled rather than dropped: the code deployed before this change
-- still selects them (expand then contract, docs/migrations-runbook.md), and a
-- null is what that code already reads as "no value". Dropping them is a later,
-- separate change once nothing names them.
--
-- secret loses NOT NULL, since no row will hold one again.

alter table webhook_endpoints
  alter column secret drop not null;

-- Idempotent: a second run finds nothing to null and says so, so "it worked" and
-- "there was nothing to do" are different answers (L98).
do $$
declare
  v_rows integer;
begin
  update webhook_endpoints
     set auth_header = null,
         secret = null
   where auth_header is not null
      or secret is not null;

  get diagnostics v_rows = row_count;

  raise notice '#3091: credentials nulled on % webhook_endpoints row(s)', v_rows;
end;
$$;
