-- #2549: store the first name the lead ANSWERED, beside the joined name.
--
-- The booker has asked for a first name in its own field since #2362, but the
-- booking stored only the joined attendee_name, so the Regal payload went on
-- deriving a first name by splitting it: "Mary Jo" / "Smith" reached Regal, and
-- the confirmation text that greets the lead from that trait, as "Mary".
--
-- NULLABLE, AND NOT BACKFILLED, deliberately. Every existing row holds only the
-- joined name, and the only way to fill this column for them is the same split
-- this column exists to replace: a guess written into a field whose whole meaning
-- is "what the lead answered" (L192). Null means nobody answered, and the Regal
-- builder falls back to the old split for exactly those rows, so they read as
-- they always have. So does every booking through the direct booking API, which
-- takes one name.
--
-- The app keeps the two columns one fact: it stores a first name only when the
-- joined name begins with it (storedFirstName, src/lib/attendee.ts), so the last
-- name is what follows it rather than a second guess.
--
-- CONTACT DATA, so erasure clears it with the other contact fields. The function
-- below is 0093's, unchanged except for that one line; retention's own redaction
-- (REDACTED_BOOKING_UPDATE) clears it too, and scripts/test-erase-booking-pii.ts
-- derives the columns erasure must clear FROM that shape, so the two cannot drift.
--
-- NOT MIRRORED. bookings is exported to Snowflake over an explicit column list
-- (src/lib/snowflake/export-core.ts), so a new column is simply not sent until the
-- warehouse table gains it with an ALTER first. That is left to its own change.

alter table bookings add column if not exists attendee_first_name text;

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
