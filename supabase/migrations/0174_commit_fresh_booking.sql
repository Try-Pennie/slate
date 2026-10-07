-- A fresh booking's final save in ONE call (#3495 step 3, part 2).
--
-- After its calendar event exists a booking made six sequential database calls: the
-- insert, the stray gcal mirror's delete, the busy block, the webhook's endpoints and
-- deliveries, the routing record, and the reservation's delete. A crowd's bookings are
-- limited by how many database REQUESTS each makes (#3492), so this does the writes in
-- one transaction. The gcal mirror delete is NOT here: #586 needs it after the commit,
-- or a push sync could write the mirror between the delete and the commit, so the
-- caller runs it after answering the lead.
--
-- WHAT IT DOES, in order:
--   1. Inserts the booking with ONLY the columns the row names, so every column it does
--      not name keeps its default (id excepted: the caller mints it, because the
--      webhook names the booking and its dedupe key IS the id). A key bookings has no
--      column for is refused by name.
--   2. A clash on any of the guards a booking passes (bookings_active_slot_uniq,
--      bookings_active_no_overlap, the 0166 reroute hold trigger, the idempotency
--      index) answers a CONFLICT with nothing written, naming the active booking that
--      holds the row's idempotency key when there is one, as the separate read after a
--      refused insert did. Any other error propagates and nothing is written.
--   3. The busy block, through move_busy_block (one copy of that rule).
--   4. The webhook, through enqueue_webhook_deliveries (one copy of the fan out), with
--      the booking id and times taken from the row as STORED, which is the rendering
--      Regal has always received, rather than the caller's.
--   5. The routing record, from the caller's row (one mapper, in TypeScript), with only
--      the columns it names, and the booking's id.
--   6. The reservation's delete, unless the webhook step failed: then it stays and the
--      reservation drain re-runs the side effects, so the webhook is not lost.
-- Steps 3 to 5 each run in their own block, so an optional write that fails is named
-- in the answer and NEVER undoes the booking, exactly as the separate calls behaved.
--
-- WHAT IT ANSWERS. {status: "committed", booking, enqueue, failed, reservation_deleted}
-- or {status: "conflict", winner}, read by `readCommitAnswer`
-- (src/lib/booking/commit-answer.ts).
create or replace function commit_fresh_booking(
  p_booking        jsonb,
  p_reservation_id uuid,
  p_webhook        jsonb,
  p_routing        jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_catalog
as $$
declare
  v_unknown  text;
  v_cols     text;
  v_booking  bookings;
  v_winner   bookings;
  v_enqueue  jsonb := null;
  v_failed   jsonb := '{}'::jsonb;
  v_deleted  boolean := false;
  v_payload  jsonb;
begin
  if p_booking is null or jsonb_typeof(p_booking) <> 'object' or coalesce(p_booking ->> 'id', '') = '' then
    raise exception 'commit_fresh_booking needs a booking row carrying its id' using errcode = '22023';
  end if;
  if p_webhook is null or jsonb_typeof(p_webhook) <> 'object' or jsonb_typeof(p_webhook -> 'payload') is distinct from 'object' then
    raise exception 'commit_fresh_booking needs a webhook with a payload' using errcode = '22023';
  end if;

  select string_agg(k, ', ' order by k) into v_unknown
    from jsonb_object_keys(p_booking) k
   where not exists (
     select 1 from pg_attribute a
      where a.attrelid = 'public.bookings'::regclass and a.attname = k and a.attnum > 0 and not a.attisdropped
   );
  if v_unknown is not null then
    raise exception 'commit_fresh_booking: bookings has no column %', v_unknown using errcode = '22023';
  end if;
  select string_agg(quote_ident(k), ', ' order by k) into v_cols from jsonb_object_keys(p_booking) k;

  -- 1, 2: the insert, the one write whose refusal is the whole answer.
  begin
    execute format(
      'insert into bookings (%1$s) select %1$s from jsonb_populate_record(null::bookings, $1) returning *',
      v_cols
    ) using p_booking into v_booking;
  exception when unique_violation or exclusion_violation then
    select * into v_winner from bookings
     where idempotency_key = p_booking ->> 'idempotency_key'
       and status in ('confirmed', 'rescheduled')
     limit 1;
    return jsonb_build_object('status', 'conflict', 'winner', case when v_winner.id is null then null else to_jsonb(v_winner) end);
  end;

  -- 3: the busy block.
  if v_booking.assigned_user_id is not null then
    begin
      perform move_busy_block(
        p_booking_id => v_booking.id,
        p_user_id    => v_booking.assigned_user_id,
        p_starts_at  => v_booking.starts_at,
        p_ends_at    => v_booking.ends_at
      );
    exception when others then
      v_failed := v_failed || jsonb_build_object('busy', sqlerrm);
    end;
  end if;

  -- 4: the webhook, with the row's own id and times.
  begin
    v_payload := (p_webhook -> 'payload') || jsonb_build_object(
      'booking_id', v_booking.id,
      'starts_at', v_booking.starts_at,
      'ends_at', v_booking.ends_at
    );
    v_enqueue := enqueue_webhook_deliveries(
      p_org_id      => v_booking.org_id,
      p_event       => p_webhook ->> 'event',
      p_payload     => v_payload,
      p_dedupe_key  => p_webhook ->> 'dedupe_key',
      p_suppression => p_webhook -> 'suppression'
    );
  exception when others then
    v_enqueue := null;
    v_failed := v_failed || jsonb_build_object('webhook', sqlerrm);
  end;

  -- 5: the routing record, when the booking was routed.
  if p_routing is not null then
    begin
      declare
        v_row jsonb := p_routing || jsonb_build_object('booking_id', v_booking.id);
        v_rcols text;
      begin
        select string_agg(quote_ident(k), ', ' order by k) into v_rcols from jsonb_object_keys(v_row) k;
        execute format(
          'insert into routing_decisions (%1$s) select %1$s from jsonb_populate_record(null::routing_decisions, $1)',
          v_rcols
        ) using v_row;
      end;
    exception when others then
      v_failed := v_failed || jsonb_build_object('routing', sqlerrm);
    end;
  end if;

  -- 6: the reservation, last, and only once the webhook is in.
  if not (v_failed ? 'webhook') then
    delete from booking_reservations where id = p_reservation_id;
    v_deleted := found;
  end if;

  return jsonb_build_object(
    'status', 'committed',
    'booking', to_jsonb(v_booking),
    'enqueue', v_enqueue,
    'failed', v_failed,
    'reservation_deleted', v_deleted
  );
end;
$$;

comment on function commit_fresh_booking(jsonb, uuid, jsonb, jsonb) is
  'A fresh booking''s save after its calendar event, in one transaction (#3495): the insert (a clash answers conflict, nothing written), the busy block, the webhook deliveries and the routing record each in their own block so none undoes the booking, and the reservation''s delete unless the webhook failed.';

-- Server side only, like every other SECURITY DEFINER function here. service_role
-- keeps its EXECUTE from the default privileges migration 0121 sets.
revoke execute on function commit_fresh_booking(jsonb, uuid, jsonb, jsonb)
  from public, anon, authenticated;
