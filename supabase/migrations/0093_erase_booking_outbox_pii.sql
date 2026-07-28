-- #1140: extend the data-subject erasure to booking_outbox.
--
-- 0092 redacted bookings, booking_events and webhook_deliveries but not
-- booking_outbox, so after honoring a deletion request a copy of the person's
-- free-text reason survived in a second table. It used to self-cap at the 30-day
-- delivered-outbox prune; since #1102 that prune PAUSES when the warehouse cannot
-- confirm a row, so the window is open-ended. The stated posture in
-- docs/pii-retention.md said the data was gone while the code left it there.
--
-- WHAT booking_outbox ACTUALLY CARRIES, measured against production (601 rows,
-- all delivered, oldest 2026-06-29) rather than assumed:
--   payload : fromAgentUserId, fromStartsIso, initiator, reasonCode, reasonDetail
--   steps[] : name, state, error
-- Only `reasonDetail` holds consumer PII (it is the same free text 0092 already
-- redacts in booking_events.reason_detail, written from the same mutation), and
-- `steps[].error` / `last_error` can embed an external response body. It is NOT
-- the attendee name/email/phone/prefill originally suspected: no producer writes
-- those here.
--
-- PENDING ROWS ARE BLANKED TOO, deliberately. Only the free-text reason is taken;
-- the operational fields the drain needs to finish a half-done mutation
-- (reasonCode, initiator, fromStartsIso, fromAgentUserId) are left intact. So a
-- still-pending reschedule drains normally and its history-write step records a
-- null reason, which is exactly the erased state we want. Nothing has to be
-- excluded by status, and no erasure ever waits on the drain.
--
-- THE WAREHOUSE HALF IS AUTOMATIC, and needs no hand-run purge. booking_outbox has
-- no set_updated_at trigger (its writers stamp updated_at from the Worker's own
-- clock) and is deliberately absent from the export's skip-redacted set
-- (src/lib/snowflake/skip-redacted.ts), so stamping updated_at here makes the next
-- export MERGE the blanked row over Snowflake's copy. Retention does not freeze:
-- the per-row verify reports `stale` until the export catches up, then allows the
-- delete. Contrast bookings, which stamp pii_redacted_at to FREEZE the export and
-- keep full fidelity in the warehouse on purpose.
--
-- Everything else about the function is unchanged from 0092: same narrow scope
-- (no salesforce_id / external_id, no calendar events), same email-hash audit,
-- same idempotency via the live attendee_email match.

create or replace function erase_booking_pii(target_email text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  norm            text := nullif(lower(trim(target_email)), '');
  ids             uuid[];
  ids_text        text[];
  v_org           uuid;
  n_bookings      integer := 0;
  n_events        integer := 0;
  n_deliveries    integer := 0;
  n_outbox        integer := 0;
begin
  if norm is null then
    raise exception 'erase_booking_pii: target_email is required';
  end if;

  -- Bookings belonging to this person, by normalized attendee email. A booking
  -- already redacted (email null) cannot match, which is what makes re-runs no-ops.
  -- Take one org via array indexing: min()/max() are undefined for the uuid type,
  -- and a person's bookings share an org, so the first is representative.
  select array_agg(id), (array_agg(org_id))[1] into ids, v_org
  from bookings
  where lower(trim(attendee_email)) = norm;

  if ids is null then
    -- Nothing matches: idempotent no-op, no audit row.
    return jsonb_build_object('erased', false, 'reason', 'no-match');
  end if;

  -- Text form of the affected ids, for matching the webhook payload's booking_id.
  ids_text := (select array_agg(x::text) from unnest(ids) as x);

  -- 1. Redact the direct contact fields (NOT salesforce_id / external_id, section
  --    4), and stamp pii_redacted_at so the Snowflake export freezes the row (#1118).
  update bookings
     set attendee_name = null,
         attendee_email = null,
         attendee_phone = null,
         prefill = '{}'::jsonb,
         pii_redacted_at = now()
   where id = any(ids);
  get diagnostics n_bookings = row_count;

  -- 2. Redact the free-text reschedule/cancel reasons on this person's events,
  --    through the #1040 sentinel (transaction-local; cleared right after).
  perform set_config('slate.allow_erasure', 'on', true);
  update booking_events
     set reason_detail = null
   where booking_id = any(ids)
     and reason_detail is not null;
  get diagnostics n_events = row_count;
  perform set_config('slate.allow_erasure', 'off', true);

  -- 3. Blank webhook delivery payloads for THIS person's bookings, matched on the
  --    affected booking ids (catches a delivery whose attendee.email is null but
  --    whose payload still carries the person's name/phone/prefill). Reuses the
  --    #1073 erased shape so no re-send path can replay a blanked row.
  update webhook_deliveries
     set payload = '{}'::jsonb,
         payload_erased = true,
         last_response = null
   where payload_erased = false
     and payload ->> 'booking_id' = any(ids_text);
  get diagnostics n_deliveries = row_count;

  -- 4. #1140: take the free-text reason (and any embedded external response body)
  --    out of this person's outbox rows, keeping the operational fields the drain
  --    needs. updated_at is stamped by hand: this table has no trigger for it, and
  --    that stamp is what makes the export overwrite the warehouse copy.
  --    Guarded so a row with nothing to erase is left alone rather than having its
  --    updated_at bumped, which would force a pointless re-export of the row.
  update booking_outbox
     set payload = payload || jsonb_build_object('reasonDetail', null),
         steps = (
           select coalesce(
                    jsonb_agg(
                      case when step ? 'error'
                           then jsonb_set(step, '{error}', 'null'::jsonb)
                           else step
                      end
                      order by ord
                    ),
                    '[]'::jsonb
                  )
           from jsonb_array_elements(steps) with ordinality as t(step, ord)
         ),
         last_error = null,
         updated_at = now()
   where booking_id = any(ids)
     and (
       nullif(payload ->> 'reasonDetail', '') is not null
       or last_error is not null
       or steps::text ~ '"error"\s*:\s*"'
     );
  get diagnostics n_outbox = row_count;

  -- 5. Audit the erasure: booking ids + an email HASH, never the cleartext email.
  insert into audit_log (org_id, actor_id, action, target_id, details)
  values (
    v_org,
    null,
    'pii.erasure',
    null,
    jsonb_build_object(
      -- Built-in sha256(bytea) (pg_catalog), NOT pgcrypto digest(): the function
      -- pins search_path=public, and pgcrypto lives in the extensions schema, so
      -- digest() is unreachable here and would error at runtime.
      'email_sha256', encode(sha256(convert_to(norm, 'UTF8')), 'hex'),
      'booking_ids', to_jsonb(ids),
      'bookings_redacted', n_bookings,
      'events_redacted', n_events,
      'deliveries_erased', n_deliveries,
      'outbox_erased', n_outbox
    )
  );

  return jsonb_build_object(
    'erased', true,
    'bookings', n_bookings,
    'events', n_events,
    'deliveries', n_deliveries,
    'outbox', n_outbox
  );
end;
$$;

-- Deny the function to the API roles; it is server/operator-only (like the
-- deny-all RLS on the tables it touches). Only the owner and postgres run it.
revoke all on function erase_booking_pii(text) from public, anon, authenticated;
