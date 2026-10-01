-- #2944: each Regal call's lead, start and talk time, kept for 120 days.
--
-- WHY. The show rate in the Slate vs cal.com split (#2941) is judged from Regal
-- calls: a human call with enough talk time starting near the booking's final
-- start. Slate already receives every `call.completed` at POST /api/regal/calls
-- (about 6,000 a weekday), and the body carries everything that judgement needs,
-- but nothing kept it: regal_call_events stores only the detector's fields for
-- three days.
--
-- WHY A SEPARATE TABLE, not more columns on regal_call_events. That table is the
-- detector's PER REASON COUNTER (#2090): one row per received event under the one
-- reason it was kept or dropped, with a CHECK (regal_call_events_candidate_shape)
-- that lets only a candidate carry a person or an instant, and a three day
-- retention sized to the detector's own windows. An outcome is wanted for EVERY
-- completed call, the AI agent's and the unanswered dialer attempt's included,
-- for 120 days. Widening that table would break its shape constraint, stretch its
-- retention forty times over and mix two questions in one row.
--
-- WHAT A ROW HOLDS. The lead's Salesforce Lead id, as its 15 character key
-- (Dan decided on 2026-10-01 that the Salesforce id is an external id and safe to
-- store), Regal's event id, the call's start and talk time, and its labels:
-- direction, type, disposition, whether a conversation happened, whether the AI
-- agent placed it, and the acting agent's work address (staff data). NO phone, NO
-- email address of the lead, NO name, NO notes: the body carries all of those and
-- src/lib/regal/inbound-call.ts never reads them. Dispositions are kept so #324
-- can build on them.
--
-- A GROWTH TABLE (about 6,000 calls a weekday, so roughly half a million rows at
-- the 120 day window), so it is deliberately NOT on the capped read guard's
-- SAFE_TABLES list and every read of it must be bounded. NOT mirrored to
-- Snowflake, and outside the erasure function: it holds an external reference to
-- the lead and no contact data. Pruned by the prune-regal-calls lane on the 03:05
-- daily trigger once a row was received more than REGAL_OUTCOME_RETENTION_DAYS
-- (120) ago.
create table regal_call_outcomes (
  id                    uuid primary key default gen_random_uuid(),
  -- Regal's top level `eventId`. NOT NULL and UNIQUE: the constraint is what makes
  -- a redelivery harmless (the insert is ON CONFLICT DO NOTHING), and a body with
  -- no readable id is refused at the edge rather than stored unkeyed.
  event_id              text not null unique,
  -- The lead's Salesforce Lead id (`userId` on the body), first 15 characters.
  lead_key              text not null,
  -- When the call started, from Regal's unix SECONDS `started_at`.
  started_at            timestamptz not null,
  -- Regal's `talk_time`, in seconds. Refused at the edge when absent or not a
  -- number, never stored as zero, and refused here too if it is negative.
  talk_time_s           integer not null check (talk_time_s >= 0),
  -- The labels. Null when Regal sent nothing readable; never guessed.
  conversation_happened boolean,
  direction             text,
  call_type             text,
  disposition           text,
  is_ai_agent           boolean not null,
  -- The acting agent's normalised work address. Null on an unanswered dialer
  -- attempt, which has nobody on it.
  agent_email           text,
  -- When Slate received it. Retention and the monitor's ratio both window on it.
  received_at           timestamptz not null default now()
);

-- The split's read: this lead's calls around this booking's start.
create index regal_call_outcomes_lead_started_idx on regal_call_outcomes (lead_key, started_at);

-- Retention and the monitor's written against received ratio window on arrival.
create index regal_call_outcomes_received_at_idx on regal_call_outcomes (received_at);

-- Server reads and writes through the secret key client only; no client access.
alter table regal_call_outcomes enable row level security;

comment on table regal_call_outcomes is
  'The #2944 Regal call outcomes: one row per completed call, keyed on Regal''s eventId, holding the lead''s Salesforce Lead id key, start, talk time and labels for the show rate. No contact data. Kept 120 days by prune-regal-calls.';
