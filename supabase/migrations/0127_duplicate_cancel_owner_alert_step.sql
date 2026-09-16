-- #2433: the duplicate cancel takes the advisor's alert off the calendar too.
--
-- #2371 added `cancel:owner_alert_delete` to `cancelOutboxSteps()`, so cancelling a
-- booking removes the advisor only "previously pitched" entry from the owner's
-- calendar. `cancel_duplicate_booking` (0124) enqueues its own cancel row in SQL and
-- so holds a SECOND copy of that list, which 0124 could not carry: a step with no
-- handler FAILS its outbox row, and a migration is applied BEFORE the code that needs
-- it deploys (L640), so a migration enqueueing this step would have broken every Regal
-- duplicate cancel in the window between the apply and the deploy.
--
-- #2371 is deployed, so the handler is live and this is now safe. The whole function is
-- restated because `create or replace` takes a complete definition; the ONLY change is
-- the step array below, which now matches `cancelOutboxSteps()` exactly, in order.
-- `scripts/test-duplicate-cancel.ts` reads whichever migration defines the function
-- last and compares that array against the executor's own list, with its exemption
-- list now empty: an empty list is the proof the two copies agree.

-- The refusal helper is restated with it, unchanged. `create or replace` takes a whole
-- definition, and the two are read together: the named booking's own states (already
-- cancelled as a duplicate, any other terminal status, a call that has begun) are
-- decided here, so a file carrying only the outer function would leave those rules in
-- 0124 while this file is the one that defines the behaviour today.

create or replace function cancel_duplicate_named_refusal(
  p_booking bookings,
  p_now     timestamptz
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
begin
  if p_booking.status = 'cancelled' then
    if exists (
      select 1
      from booking_outbox o
      where o.booking_id = p_booking.id
        and o.action = 'cancel'
        and o.payload ->> 'reasonCode' = 'double_booking'
    ) or exists (
      select 1
      from booking_events e
      where e.booking_id = p_booking.id
        and e.action = 'cancelled'
        and e.reason_code = 'double_booking'
    ) then
      return 'already-cancelled';
    end if;
    return 'not-active';
  end if;

  if p_booking.status not in ('confirmed', 'rescheduled') then
    return 'not-active';
  end if;

  if p_booking.starts_at <= p_now then
    return 'started';
  end if;

  return null;
end;
$$;

revoke execute on function cancel_duplicate_named_refusal(bookings, timestamptz)
  from public, anon, authenticated;

create or replace function cancel_duplicate_booking(
  p_booking_id uuid,
  p_now        timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_named      bookings%rowtype;
  v_refusal    text;
  v_is_test    boolean;
  v_email_key  text;
  v_phone_key  text;
  v_ids        uuid[];
  v_cand       record;
  v_same       uuid[] := array[]::uuid[];
  v_newer      uuid[] := array[]::uuid[];
  v_conflict   boolean := false;
  v_weak_email boolean := false;
  v_weak_phone boolean := false;
  v_weaker     text := null;
  v_sf_hit     boolean;
  v_ext_hit    boolean;
  v_strong     boolean;
  v_email_hit  boolean;
  v_phone_hit  boolean;
  v_clash      boolean;
  v_outbox_id  uuid;
  v_steps      jsonb;
  v_payload    jsonb;
  v_updated    integer;
begin
  -- Phase 1: read the named booking unlocked, purely to learn its identity and to
  -- refuse the cheap cases without locking anything.
  select * into v_named from bookings where id = p_booking_id;
  if not found then
    return jsonb_build_object('outcome', 'not-found', 'candidateIds', '[]'::jsonb, 'weakerMatch', null::text);
  end if;

  v_refusal := cancel_duplicate_named_refusal(v_named, p_now);
  if v_refusal is not null then
    return jsonb_build_object('outcome', v_refusal, 'candidateIds', '[]'::jsonb, 'weakerMatch', null::text);
  end if;

  select coalesce(bk.is_test, false) into v_is_test
  from buckets bk
  where bk.id = v_named.bucket_id;
  v_is_test := coalesce(v_is_test, false);

  v_email_key := nullif(lower(btrim(v_named.attendee_email)), '');
  v_phone_key := slate_phone_match_key(v_named.attendee_phone);

  -- Phase 2: which rows could be the same person. `bookings` carries no is_test
  -- column, so the test space comes from the BUCKET, which is what the smoke canary
  -- books into (#396): a synthetic booking must never authorise cancelling a real
  -- call, and a real one must never authorise cancelling the canary's.
  select coalesce(array_agg(b.id), array[]::uuid[])
    into v_ids
  from bookings b
  join buckets bk on bk.id = b.bucket_id
  where b.id <> v_named.id
    and b.status in ('confirmed', 'rescheduled')
    and b.starts_at > p_now
    and coalesce(bk.is_test, false) = v_is_test
    and (
         (v_named.salesforce_id is not null and b.salesforce_id = v_named.salesforce_id)
      or (v_named.external_id  is not null and b.external_id  = v_named.external_id)
      or (v_email_key is not null and nullif(lower(btrim(b.attendee_email)), '') = v_email_key)
      or (v_phone_key is not null and slate_phone_match_key(b.attendee_phone) = v_phone_key)
    );

  -- Phase 3: one ordered lock over the named row and every candidate, so two calls
  -- about one lead's two bookings take the locks in the same order.
  v_ids := v_ids || v_named.id;
  perform b.id
  from bookings b
  where b.id = any (v_ids)
  order by b.id
  for update;

  -- Phase 4: re-read the named row under the lock and judge it again. Nothing above
  -- this line decided anything.
  select * into v_named from bookings where id = p_booking_id;
  if not found then
    return jsonb_build_object('outcome', 'not-found', 'candidateIds', '[]'::jsonb, 'weakerMatch', null::text);
  end if;
  v_refusal := cancel_duplicate_named_refusal(v_named, p_now);
  if v_refusal is not null then
    return jsonb_build_object('outcome', v_refusal, 'candidateIds', '[]'::jsonb, 'weakerMatch', null::text);
  end if;

  -- Re-derived from the LOCKED row, not the snapshot the ids were gathered from. The
  -- candidate SET may be one row short of a concurrent write (see the header), but
  -- every candidate in it is classified against the contact details the named booking
  -- actually holds now, which is what a lead correcting their number mid call would
  -- otherwise have made stale.
  v_email_key := nullif(lower(btrim(v_named.attendee_email)), '');
  v_phone_key := slate_phone_match_key(v_named.attendee_phone);

  -- Phase 5: classify the locked candidates. Their status and start are stable now.
  for v_cand in
    select b.id,
           b.created_at,
           b.salesforce_id,
           b.external_id,
           nullif(lower(btrim(b.attendee_email)), '')   as email_key,
           slate_phone_match_key(b.attendee_phone)      as phone_key
    from bookings b
    where b.id = any (v_ids)
      and b.id <> v_named.id
      and b.status in ('confirmed', 'rescheduled')
      and b.starts_at > p_now
    order by b.id
  loop
    v_sf_hit  := v_named.salesforce_id is not null and v_cand.salesforce_id = v_named.salesforce_id;
    v_ext_hit := v_named.external_id  is not null and v_cand.external_id  = v_named.external_id;
    v_strong  := coalesce(v_sf_hit, false) or coalesce(v_ext_hit, false);
    v_email_hit := v_email_key is not null and v_cand.email_key = v_email_key;
    v_phone_hit := v_phone_key is not null and v_cand.phone_key = v_phone_key;
    v_email_hit := coalesce(v_email_hit, false);
    v_phone_hit := coalesce(v_phone_hit, false);

    if not v_strong and not v_email_hit and not v_phone_hit then
      continue;
    end if;

    -- A strong id that MATCHES settles identity before a conflict is asked, so a lead
    -- whose two calls share a Salesforce id and differ on an external id is one
    -- person rather than a contradiction.
    v_clash := (not coalesce(v_sf_hit, false)
                and v_named.salesforce_id is not null
                and v_cand.salesforce_id is not null)
            or (not coalesce(v_ext_hit, false)
                and v_named.external_id is not null
                and v_cand.external_id is not null);

    if v_strong then
      v_same := v_same || v_cand.id;
      if v_cand.created_at > v_named.created_at then
        v_newer := v_newer || v_cand.id;
      end if;
    elsif v_email_hit and v_phone_hit then
      if v_clash then
        v_conflict := true;
      else
        v_same := v_same || v_cand.id;
        if v_cand.created_at > v_named.created_at then
          v_newer := v_newer || v_cand.id;
        end if;
      end if;
    elsif v_email_hit then
      v_weak_email := true;
    else
      v_weak_phone := true;
    end if;
  end loop;

  -- An address identifies a person better than a line a household shares, so when
  -- both kinds of near miss exist the address is the one the notice names.
  if v_weak_email then
    v_weaker := 'email-only';
  elsif v_weak_phone then
    v_weaker := 'phone-only';
  end if;

  -- The conflict is a HARD veto rather than a per candidate exclusion. This endpoint
  -- exists so a wrong id can never cancel somebody's only call, so two upcoming calls
  -- sharing an email and phone under different strong ids means a person looks, even
  -- when a third call would otherwise have authorised the cancel.
  if v_conflict then
    return jsonb_build_object('outcome', 'identity-conflict',
                              'candidateIds', to_jsonb(v_same), 'weakerMatch', v_weaker);
  end if;
  if array_length(v_same, 1) is null then
    return jsonb_build_object('outcome', 'no-other-call',
                              'candidateIds', '[]'::jsonb, 'weakerMatch', v_weaker);
  end if;
  if array_length(v_newer, 1) is null then
    return jsonb_build_object('outcome', 'named-is-newest',
                              'candidateIds', to_jsonb(v_same), 'weakerMatch', v_weaker);
  end if;

  -- The flip and the outbox row, together. Nothing can crash between them, so the
  -- calendar delete, the slot recompute and the cancelled webhook can never be
  -- stranded by a booking that is already cancelled (#429 P3, L33). The route runs
  -- the row inline; the /api/cron/outbox drain is what covers a crash after commit.
  update bookings
     set status = 'cancelled'
   where id = v_named.id
     and status in ('confirmed', 'rescheduled');
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'cancel_duplicate_booking: expected to cancel 1 row, changed %', v_updated;
  end if;

  v_steps := jsonb_build_array(
    jsonb_build_object('name', 'cancel:gcal_delete',        'state', 'pending'),
    jsonb_build_object('name', 'cancel:busyblock_delete',   'state', 'pending'),
    jsonb_build_object('name', 'cancel:recompute',          'state', 'pending'),
    jsonb_build_object('name', 'cancel:owner_alert_delete', 'state', 'pending'),
    jsonb_build_object('name', 'cancel:notify',             'state', 'pending')
  );

  -- The same payload `cancelBooking` writes, so the executor's notify step reads one
  -- shape whichever producer enqueued the row. `fromStartsIso` is rendered in the
  -- exact format the TypeScript side writes, so a drained row and an inline one
  -- record the same history.
  v_payload := jsonb_build_object(
    'reasonCode',      'double_booking',
    'reasonDetail',    null::text,
    'initiator',       'system',
    'fromStartsIso',   to_char(v_named.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'fromAgentUserId', v_named.assigned_user_id
  );

  insert into booking_outbox (booking_id, action, steps, payload)
  values (v_named.id, 'cancel', v_steps, v_payload)
  returning id into v_outbox_id;

  return jsonb_build_object(
    'outcome',      'cancelled',
    'outboxId',     v_outbox_id,
    'candidateIds', to_jsonb(v_same),
    'weakerMatch',  v_weaker
  );
end;
$$;

comment on function cancel_duplicate_booking(uuid, timestamptz) is
  'Cancel a named booking only when Slate can establish it is a duplicate (#2369). Decides and cancels in one transaction, returning the outcome, the outbox row it wrote and the candidates it judged.';

-- Server side only, like every other SECURITY DEFINER function here. service_role
-- keeps its EXECUTE from the default privileges migration 0121 sets.
revoke execute on function cancel_duplicate_booking(uuid, timestamptz)
  from public, anon, authenticated;
