-- Write a webhook's deliveries in ONE call (#3495).
--
-- Every booking webhook reached the database at least twice: emitWebhook read the
-- org's active endpoints subscribed to the event, then inserted one delivery row per
-- endpoint. A crowd's bookings are limited by how many database REQUESTS each makes,
-- not by the work inside them (#3492: Postgres was busy 0.4% of the time since June
-- while each call took 90 to 200ms), so this does the read and every insert in one
-- call, and it is now the only place the subscription rule and the exactly once
-- dedupe live. emitWebhook calls it for every event; a fresh booking's own commit
-- will too (#3495 step 3).
--
-- WHAT IT DOES. For each active endpoint of the org whose `events` contains the event,
-- in the order they were added, it inserts one delivery carrying the payload and the
-- dedupe key. A delivery the caller says is suppressed (a smoke test bucket's booking,
-- #459; an agent link booking Regal is sent nothing for, #2073) is written in a
-- TERMINAL state, success with the reason as its last response, so the retry sweep can
-- never send it. A repeat of the same logical event (the same endpoint, event and
-- dedupe key, webhook_deliveries_dedupe_uniq from 0046) writes nothing and is not an
-- error: the original delivery owns the send and its retries. A null key opts out of
-- the dedupe, as it always has.
--
-- WHO DECIDES SUPPRESSION. The caller, per FORMAT, because the rule reads the payload
-- and lives in TypeScript (`suppressionFor`, src/lib/webhooks/emit.ts). An endpoint
-- whose format the map does not name is REFUSED, with nothing written, rather than read
-- as "not suppressed": a missing key and a JSON null read the same through ->>, and the
-- fail open reading would POST a smoke booking to a real receiver (L42).
--
-- WHAT IT ANSWERS. {subscribers, deliveries: [{id, suppressed, payload, endpoint}]}:
-- how many endpoints subscribe (zero is an answer the caller logs, #1459), and every
-- delivery it wrote, with the payload AS STORED and the endpoint row, so the first send
-- posts exactly what every retry will.
create or replace function enqueue_webhook_deliveries(
  p_org_id      uuid,
  p_event       text,
  p_payload     jsonb,
  p_dedupe_key  text,
  p_suppression jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_catalog
as $$
declare
  v_endpoint    webhook_endpoints;
  v_suppression text;
  v_delivery    webhook_deliveries;
  v_subscribers int := 0;
  v_deliveries  jsonb := '[]'::jsonb;
begin
  if p_org_id is null or p_event is null or p_event = '' then
    raise exception 'enqueue_webhook_deliveries needs an org and an event' using errcode = '22023';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'enqueue_webhook_deliveries needs a payload object' using errcode = '22023';
  end if;
  if p_suppression is null or jsonb_typeof(p_suppression) <> 'object' then
    raise exception 'enqueue_webhook_deliveries needs a suppression decision per format' using errcode = '22023';
  end if;

  for v_endpoint in
    select * from webhook_endpoints
     where org_id = p_org_id
       and active
       and events @> array[p_event]
     order by created_at, id
  loop
    v_subscribers := v_subscribers + 1;
    if not (p_suppression ? v_endpoint.format) then
      raise exception 'enqueue_webhook_deliveries has no suppression decision for the % format', v_endpoint.format
        using errcode = '22023';
    end if;
    v_suppression := p_suppression ->> v_endpoint.format;

    insert into webhook_deliveries (endpoint_id, event, payload, status, dedupe_key, suppressed, last_response)
    values (
      v_endpoint.id,
      p_event,
      p_payload,
      case when v_suppression is null then 'pending' else 'success' end,
      p_dedupe_key,
      v_suppression is not null,
      v_suppression
    )
    on conflict (endpoint_id, event, dedupe_key) where dedupe_key is not null do nothing
    returning * into v_delivery;

    if found then
      v_deliveries := v_deliveries || jsonb_build_array(jsonb_build_object(
        'id', v_delivery.id,
        'suppressed', v_delivery.suppressed,
        'payload', v_delivery.payload,
        'endpoint', to_jsonb(v_endpoint)
      ));
    end if;
  end loop;

  return jsonb_build_object('subscribers', v_subscribers, 'deliveries', v_deliveries);
end;
$$;

comment on function enqueue_webhook_deliveries(uuid, text, jsonb, text, jsonb) is
  'Write one delivery per active endpoint subscribed to the event, deduped on (endpoint, event, dedupe_key), suppression decided by the caller per format (#3495). Returns the subscriber count and the deliveries written, each with its stored payload and endpoint.';

-- Server side only, like every other SECURITY DEFINER function here. service_role
-- keeps its EXECUTE from the default privileges migration 0121 sets.
revoke execute on function enqueue_webhook_deliveries(uuid, text, jsonb, text, jsonb)
  from public, anon, authenticated;
