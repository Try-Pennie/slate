-- #1072 (phase 3 of the #1029 PII/compliance milestone): the data-subject
-- erasure function. An operator runs erase_booking_pii(<email>) to honor a
-- deletion request (see docs/pii-erasure-runbook.md). Chosen over an admin UI
-- for a smaller attack surface.
--
-- SCOPE IS DELIBERATELY NARROW (docs/pii-retention.md §4/§7, Dan 2026-07-23):
-- it clears ONLY the contact data Slate collected. It does NOT touch
-- salesforce_id / external_id (Salesforce is the system of record for that
-- identity) and does NOT delete the agent's Google Calendar events (a completed
-- meeting is the agent's operational record; only a real cancellation deletes
-- an event). The audit trail records an email HASH, never the cleartext email.
--
-- Idempotent: keyed on a live attendee_email match, so once a person's rows are
-- redacted a re-run finds nothing and is a no-op (and writes no audit row).
--
-- SECURITY DEFINER so it runs with owner privileges regardless of caller. The
-- #1040 append-only trigger on booking_events fires regardless of role, so the
-- function sets the slate.allow_erasure GUC transaction-locally to pass it, then
-- clears it. audit_log INSERT is unaffected by that trigger (INSERT is allowed).

create or replace function erase_booking_pii(target_email text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  norm            text := nullif(lower(trim(target_email)), '');
  ids             uuid[];
  v_org           uuid;
  n_bookings      integer := 0;
  n_events        integer := 0;
  n_deliveries    integer := 0;
begin
  if norm is null then
    raise exception 'erase_booking_pii: target_email is required';
  end if;

  -- Bookings belonging to this person, by normalized attendee email. A booking
  -- already redacted (email null) cannot match, which is what makes re-runs no-ops.
  select array_agg(id), min(org_id) into ids, v_org
  from bookings
  where lower(trim(attendee_email)) = norm;

  if ids is null then
    -- Nothing matches: idempotent no-op, no audit row.
    return jsonb_build_object('erased', false, 'reason', 'no-match');
  end if;

  -- 1. Redact the direct contact fields (NOT salesforce_id / external_id, §4).
  update bookings
     set attendee_name = null,
         attendee_email = null,
         attendee_phone = null,
         prefill = '{}'::jsonb
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

  -- 3. Blank webhook delivery payloads that carry THIS attendee's email, matched
  --    on the exact attendee path (never a top-level or agent email). Reuses the
  --    #1073 erased shape so no re-send path can replay a blanked row.
  update webhook_deliveries
     set payload = '{}'::jsonb,
         payload_erased = true,
         last_response = null
   where payload_erased = false
     and lower(trim(payload -> 'attendee' ->> 'email')) = norm;
  get diagnostics n_deliveries = row_count;

  -- 4. Audit the erasure: booking ids + an email HASH, never the cleartext email.
  insert into audit_log (org_id, actor_id, action, target_id, details)
  values (
    v_org,
    null,
    'pii.erasure',
    null,
    jsonb_build_object(
      'email_sha256', encode(digest(norm, 'sha256'), 'hex'),
      'booking_ids', to_jsonb(ids),
      'bookings_redacted', n_bookings,
      'events_redacted', n_events,
      'deliveries_erased', n_deliveries
    )
  );

  return jsonb_build_object(
    'erased', true,
    'bookings', n_bookings,
    'events', n_events,
    'deliveries', n_deliveries
  );
end;
$$;

-- Deny the function to the API roles; it is server/operator-only (like the
-- deny-all RLS on the tables it touches). Only the owner and postgres run it.
revoke all on function erase_booking_pii(text) from public, anon, authenticated;
