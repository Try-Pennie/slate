-- #1040 (part of the #1029 PII/compliance milestone): make audit_log and
-- booking_events tamper-evident.
--
-- Both tables are append-only by CONVENTION only today: no REVOKE or trigger
-- stops UPDATE/DELETE, and all server code uses the RLS-bypassing secret-key
-- client, so any compromised or buggy path can silently rewrite audit history.
-- These triggers raise on UPDATE, DELETE, and TRUNCATE, so the tables are
-- tamper-evident even against the secret key, short of dropping the trigger.
-- (Row UPDATE/DELETE triggers do not fire on TRUNCATE, so the bulk-wipe case
-- needs its own statement-level guard.) INSERT is unaffected: both tables keep
-- working normally.
--
-- audit_log is STRICTLY immutable (no bypass): its trail is never redacted or
-- deleted; erasure (#1072) only APPENDS an audit entry (see pii-retention.md §4).
--
-- booking_events allows ONE sanctioned bypass so the #1072 erasure function can
-- redact reason_detail: it passes when the session GUC `slate.allow_erasure` is
-- set to 'on' (transaction-local) inside erase_booking_pii, and only then. This
-- is the §5 ordering-contract sentinel; shipping it now lets #1072 land later
-- without breaking the trigger.
--
-- SIDE EFFECT (deliberate): because of existing FKs, these triggers also block
-- the write side-effects of hard-deleting related rows:
--   * bookings -> booking_events (ON DELETE CASCADE): deleting a booking would
--     cascade-DELETE its events and be blocked;
--   * users -> booking_events.from/to_agent_user_id and audit_log.actor_id/
--     target_id (ON DELETE SET NULL): deleting a user would UPDATE these to NULL
--     and be blocked;
--   * organizations -> audit_log.org_id (ON DELETE CASCADE): deleting an org
--     would cascade-DELETE its audit rows and be blocked.
-- This is safe: the roster is deactivate-not-delete, orgs/bookings are never
-- hard-deleted, and #1071 redacts booking PII in place. It is also the intended
-- behavior: the audit trail must survive even a deletion of what it references.

-- Unconditional block. Used for everything on audit_log, and for TRUNCATE on
-- booking_events (a bulk wipe is never a sanctioned mutation). Works for both
-- row (UPDATE/DELETE) and statement (TRUNCATE) triggers since it ignores OLD/NEW.
create or replace function slate_append_only_block()
  returns trigger language plpgsql as $$
begin
  raise exception '% is append-only (tamper-evident, #1040)', tg_table_name;
end;
$$;

-- booking_events UPDATE/DELETE: the ONLY sanctioned mutation path is the #1072
-- erasure function, which sets slate.allow_erasure='on' transaction-locally
-- before redacting reason_detail. TRUNCATE is never allowed (see below).
create or replace function slate_booking_events_append_only()
  returns trigger language plpgsql as $$
begin
  if current_setting('slate.allow_erasure', true) is distinct from 'on' then
    raise exception 'booking_events is append-only outside the sanctioned erasure path (#1040/#1072)';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- audit_log: fully immutable. Row-level UPDATE/DELETE triggers do NOT fire on
-- TRUNCATE, so a separate statement-level TRUNCATE guard is required to close
-- the bulk-wipe gap.
create trigger audit_log_no_update_delete
  before update or delete on audit_log
  for each row execute function slate_append_only_block();

create trigger audit_log_no_truncate
  before truncate on audit_log
  for each statement execute function slate_append_only_block();

-- booking_events: UPDATE/DELETE via the erasure sentinel; TRUNCATE always
-- blocked (erasure redacts specific rows, it never truncates).
create trigger booking_events_no_update_delete
  before update or delete on booking_events
  for each row execute function slate_booking_events_append_only();

create trigger booking_events_no_truncate
  before truncate on booking_events
  for each statement execute function slate_append_only_block();
