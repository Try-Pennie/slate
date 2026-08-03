-- One-time backfill of the OOO audit trail lost to #1220.
--
-- Every ooo.* audit write since OOO shipped was rejected by
-- audit_log_target_id_fkey: the caller passed an ooo_requests id into
-- target_id, which references users(id). The action itself always went
-- through, so ooo_requests still holds who did what and when, and this
-- reconstructs the missing trail from it.
--
-- SCOPE: only requests CREATED IN SLATE (legacy_request_id is null). The 675
-- rows imported from the Apps Script sheet carry no decided_by and no
-- decided_at, so an approve row for them would have to invent both the actor
-- and the timestamp. The sheet remains the record for what happened before
-- Slate; this trail starts when Slate did.
--
-- EVERY ROW IS MARKED `details.reconstructed = true`. audit_log is immutable by
-- trigger (0089), so a backdated row that claimed to be contemporaneous could
-- never be corrected. A reader must be able to tell a rebuilt row from one
-- written at the time.
--
-- KNOWN GAPS, deliberately left empty rather than guessed:
--   * ooo.modify: at least 13 requests carry a "[Modified ...]" note marker,
--     but no modify actor or precise timestamp was ever stored.
--   * ooo.cancel actor: cancelOoo never wrote a canceller, so actor_id is
--     null. Null means "not recorded", which is the truth. (decided_by on a
--     cancelled row is the earlier APPROVER, not the canceller, so it must not
--     be reused here.)
--   * ooo.retry: no retry was ever persisted anywhere.
--
-- IDEMPOTENT: each branch skips a request that already has that action, keyed on
-- details->>'ooo_request_id'. Re-running inserts zero rows.
--
-- Run with the /db-apply skill. Reports the row count of every statement.

begin;

-- 1. submit: the agent submitted their own request (submitOoo takes the agent as
--    both actor and subject), stamped at the row's creation.
insert into audit_log (org_id, actor_id, action, target_id, details, created_at)
select
  r.org_id,
  r.user_id,
  'ooo.submit',
  r.user_id,
  jsonb_build_object(
    'ooo_request_id', r.id::text,
    'starts_at', r.starts_at,
    'ends_at', r.ends_at,
    'reconstructed', true,
    'reconstructed_from', 'ooo_requests'
  ),
  r.created_at
from ooo_requests r
where r.legacy_request_id is null
  and not exists (
    select 1 from audit_log a
    where a.action = 'ooo.submit'
      and a.details->>'ooo_request_id' = r.id::text
  );

-- 2. approve: decided_by/decided_at hold the real approver and moment. Includes
--    cancelled rows that were approved first, since cancelOoo leaves the
--    approval stamp intact.
insert into audit_log (org_id, actor_id, action, target_id, details, created_at)
select
  r.org_id,
  r.decided_by,
  'ooo.approve',
  r.user_id,
  jsonb_build_object(
    'ooo_request_id', r.id::text,
    'reconstructed', true,
    'reconstructed_from', 'ooo_requests'
  ),
  r.decided_at
from ooo_requests r
where r.legacy_request_id is null
  and r.status in ('approved', 'cancelled')
  and r.decided_by is not null
  and r.decided_at is not null
  and not exists (
    select 1 from audit_log a
    where a.action = 'ooo.approve'
      and a.details->>'ooo_request_id' = r.id::text
  );

-- 3. reject: same stamps, plus the note the manager gave at the time.
insert into audit_log (org_id, actor_id, action, target_id, details, created_at)
select
  r.org_id,
  r.decided_by,
  'ooo.reject',
  r.user_id,
  jsonb_build_object(
    'ooo_request_id', r.id::text,
    'rejection_note', r.rejection_note,
    'reconstructed', true,
    'reconstructed_from', 'ooo_requests'
  ),
  r.decided_at
from ooo_requests r
where r.legacy_request_id is null
  and r.status = 'rejected'
  and r.decided_by is not null
  and r.decided_at is not null
  and not exists (
    select 1 from audit_log a
    where a.action = 'ooo.reject'
      and a.details->>'ooo_request_id' = r.id::text
  );

-- 4. cancel: cancelled_at is real; the actor was never recorded, so it stays
--    null. `was_approved` mirrors what the live write records.
insert into audit_log (org_id, actor_id, action, target_id, details, created_at)
select
  r.org_id,
  null,
  'ooo.cancel',
  r.user_id,
  jsonb_build_object(
    'ooo_request_id', r.id::text,
    'was_approved', (r.decided_by is not null),
    'reconstructed', true,
    'reconstructed_from', 'ooo_requests',
    'actor_not_recorded', true
  ),
  r.cancelled_at
from ooo_requests r
where r.legacy_request_id is null
  and r.status = 'cancelled'
  and r.cancelled_at is not null
  and not exists (
    select 1 from audit_log a
    where a.action = 'ooo.cancel'
      and a.details->>'ooo_request_id' = r.id::text
  );

commit;
