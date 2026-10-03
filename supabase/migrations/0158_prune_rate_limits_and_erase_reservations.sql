-- Two PII data fixes, one migration.
--
-- 1. #3109: prune rate_limits.
--
-- 0024 said the table "needs no cleanup job" because a key's row is reused in
-- place. That holds per key and not for the table: every caller IP, and since
-- #1033 every lead's normalized email and phone, is a key of its own, so the
-- table grew one row per visitor for ever and kept contact data outside every
-- retention and erasure lane.
--
-- prune_rate_limits deletes rows under the LIMITER prefixes it is given whose
-- window opened more than p_older_than_seconds ago. Such a row is already dead:
-- rate_limit_hit resets an expired window in place, exactly as it inserts a fresh
-- one. It is scoped by prefix, never by age alone, because the same table holds
-- the cron lanes' streak counters and the boundary counts, whose windows run to
-- hours and are named nowhere a prune could read; deleting one mid streak would
-- reset its count and hold back a page. A limiter key is always prefix, colon,
-- caller, so the match is starts_with on prefix plus the colon, which keeps
-- book:h away from book:contact:h, and never LIKE, whose _ and % would turn a
-- prefix into a pattern. The age is read on the database clock that stamped
-- window_start.
--
-- The caller (rateLimitPrunePlan, src/lib/rate-limit-core.ts) derives both
-- arguments from the rule table, and the daily retention trigger runs it. One
-- statement over a table with no window_start index is a sequential scan, which
-- once a day over a table this prune keeps to about a day of callers is cheap.
--
-- 2. #3126: erase_booking_pii takes the person's booking_reservations rows.
--
-- A reservation holds the whole attendee record and the manage token in
-- payload.booking until the booking lands, and nothing erased it. The function
-- below is 0145's with one step added, and that step runs BEFORE the no-match
-- return: a person with only a pending reservation still has data here, and a
-- reservation the drain resumed after the erasure would recreate the booking.
-- The reservation is DELETED rather than redacted, since a payload with its
-- attendee removed is one the drain can only fail on.

create or replace function prune_rate_limits(
  p_prefixes text[],
  p_older_than_seconds int
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n_deleted integer := 0;
begin
  if p_prefixes is null or cardinality(p_prefixes) = 0 then
    raise exception 'prune_rate_limits: at least one prefix is required';
  end if;
  if exists (select 1 from unnest(p_prefixes) as p(prefix) where coalesce(p.prefix, '') = '') then
    raise exception 'prune_rate_limits: an empty prefix would match every key';
  end if;
  -- An hour is the longest limiter window, so anything shorter than that is a
  -- caller mistake that would delete open windows.
  if p_older_than_seconds is null or p_older_than_seconds < 3600 then
    raise exception 'prune_rate_limits: p_older_than_seconds must be at least 3600, got %', p_older_than_seconds;
  end if;

  delete from rate_limits
   where window_start < now() - make_interval(secs => p_older_than_seconds)
     and exists (
       select 1 from unnest(p_prefixes) as p(prefix)
        where starts_with(key, p.prefix || ':')
     );
  get diagnostics n_deleted = row_count;
  return n_deleted;
end
$$;

-- Deny-all by default; only the secret-key server client may call it.
revoke execute on function prune_rate_limits(text[], int) from public, anon, authenticated;

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
  v_res_org       uuid;
  n_bookings      integer := 0;
  n_events        integer := 0;
  n_deliveries    integer := 0;
  n_outbox        integer := 0;
  n_reservations  integer := 0;
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

  -- 0. #3126: the person's create reservations, matched on the same normalized
  --    email inside the payload. Before the no-match return on purpose: a pending
  --    reservation can exist with no booking yet. Its org names the audit row
  --    when no booking does.
  with gone as (
    delete from booking_reservations
     where lower(trim(payload -> 'booking' ->> 'attendee_email')) = norm
    returning (payload -> 'booking' ->> 'org_id')::uuid as org_id
  )
  select count(*), (array_agg(org_id))[1] into n_reservations, v_res_org from gone;

  if ids is null and n_reservations = 0 then
    -- Nothing matches: idempotent no-op, no audit row.
    return jsonb_build_object('erased', false, 'reason', 'no-match');
  end if;
  v_org := coalesce(v_org, v_res_org);

  -- Text form of the affected ids, for matching the webhook payload's booking_id.
  -- Null when only a reservation matched, and = any(null) matches no row, so the
  -- steps below are then no-ops.
  ids_text := (select array_agg(x::text) from unnest(ids) as x);

  -- 1. Redact the direct contact fields (NOT salesforce_id / external_id, section
  --    4), and stamp pii_redacted_at so the Snowflake export freezes the row (#1118).
  update bookings
     set attendee_name = null,
         attendee_first_name = null,
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
      'booking_ids', coalesce(to_jsonb(ids), '[]'::jsonb),
      'bookings_redacted', n_bookings,
      'events_redacted', n_events,
      'deliveries_erased', n_deliveries,
      'outbox_erased', n_outbox,
      'reservations_deleted', n_reservations
    )
  );

  return jsonb_build_object(
    'erased', true,
    'bookings', n_bookings,
    'events', n_events,
    'deliveries', n_deliveries,
    'outbox', n_outbox,
    'reservations', n_reservations
  );
end;
$$;

-- Deny the function to the API roles; it is server/operator-only (like the
-- deny-all RLS on the tables it touches). Only the owner and postgres run it.
revoke all on function erase_booking_pii(text) from public, anon, authenticated;
