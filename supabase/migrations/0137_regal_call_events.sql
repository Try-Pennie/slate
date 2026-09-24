-- #2090: the inbound Regal call feed, counted by reason.
--
-- Regal posts every completed call to POST /api/regal/calls. The detector this
-- feeds (a person placing calls in Regal while Slate will not route bookings to
-- them) reads only the CANDIDATE rows: a human agent, on our domain, who is a
-- Slate user. Everything else is recorded too, under the one reason it was dropped
-- for, because a filter that stores nothing on a quiet day is indistinguishable
-- from a filter that is broken or from Regal having stopped posting (L98, L506).
-- So this table IS the per reason counter: a count of rows by reason over a window
-- is the received against dropped breakdown, and because each row is keyed on
-- Regal's own event id a redelivery can never be counted twice.
--
-- WHAT A ROW HOLDS, decided by Dan on 2026-09-08: Regal's event id, the acting
-- agent's email and the call's instant, and nothing else. The body also carries
-- the lead's phone, email and Salesforce id and an AI written summary of the
-- call; none of it is stored, so this table holds NO LEAD DATA and sits outside
-- the erasure function and the Snowflake mirror, like owner_alert_events. The
-- agent email is STAFF data (docs/pii.md), and it is only written on a candidate
-- row: a dropped event carries its reason and its id and nothing about who.
--
-- A GROWTH TABLE (about 6,000 events a weekday, measured 2026-09-17), so it is
-- deliberately NOT on the capped read guard's SAFE_TABLES list and every read of
-- it must be bounded. Retention from this first migration: the prune-regal-calls
-- lane on the 03:05 daily trigger deletes rows received more than
-- REGAL_CALL_RETENTION_DAYS ago, because the detector only ever reads a recent
-- window and busy_blocks reaching 403k rows with no retention (#1252) is what
-- happens otherwise.
create table regal_call_events (
  id          uuid primary key default gen_random_uuid(),
  -- Regal's top level `eventId`. UNIQUE, and that constraint is what makes a
  -- redelivery harmless: Regal does not retry today, and can be asked to, so the
  -- endpoint is built to be safe either way. Null only when the body carried no
  -- readable id (reason event_id_unreadable or body_unreadable); NULLs are
  -- distinct under a unique constraint, so each of those is its own row, which is
  -- right: there is nothing to dedupe them on.
  event_id    text unique,
  -- The ONE reason this event was recorded under. The list is held equal to
  -- REGAL_CALL_REASONS in src/lib/regal/inbound-call.ts, in both directions, by
  -- scripts/test-regal-inbound-call.ts.
  reason      text not null check (reason in (
    'candidate',
    'not_call_completed',
    'ai_agent',
    'agent_email_null',
    'foreign_domain',
    'no_slate_user',
    'body_unreadable',
    'event_id_unreadable',
    'ai_flag_unreadable',
    'agent_email_unreadable',
    'timestamp_unreadable'
  )),
  -- The acting agent's normalised address. Candidates only.
  agent_email text,
  -- When the call completed, converted from Regal's unix SECONDS. Candidates only.
  occurred_at timestamptz,
  -- When Slate received it. Every row has one, so windows over the whole feed
  -- (the counters, retention) never depend on a field Regal may have sent badly.
  received_at timestamptz not null default now(),
  -- A candidate is exactly a row with a person and an instant, and nothing else
  -- may carry either, so a dropped event can never leak an address into storage.
  constraint regal_call_events_candidate_shape check (
    (reason = 'candidate') = (agent_email is not null and occurred_at is not null)
    and (reason = 'candidate' or (agent_email is null and occurred_at is null))
  )
);

-- Every reader windows on ARRIVAL: the detector ("what came in since I last
-- looked"), the per reason counts and retention. Arrival, not the call's own
-- instant, so a window never depends on a field Regal may have sent badly.
create index regal_call_events_received_at_idx on regal_call_events (received_at);

-- Server reads and writes through the secret key client only; no client access.
alter table regal_call_events enable row level security;

comment on table regal_call_events is
  'The #2090 inbound Regal call feed: one row per received event, keyed on Regal''s eventId, under the one reason it was kept or dropped. Candidates carry the agent email and call instant; nothing about the lead is stored. Pruned daily by prune-regal-calls.';
