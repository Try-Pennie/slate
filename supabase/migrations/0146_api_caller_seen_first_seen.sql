-- #2822: when each caller was FIRST seen from a host kind, beside when it was last.
--
-- The smoke canary used to authenticate with the shared booking key, so a server
-- call on the shared key could be the canary's and the readiness gate could not say
-- a partner held that key (#2819). The canary now has its own key and is recorded as
-- `canary`. Every shared call made AFTER the canary first authenticated on its own
-- key is therefore a partner's, and this column is how the judge knows that moment:
-- a shared row whose last sighting predates it is the canary's own history, not a
-- partner.
--
-- Filled by the DATABASE on insert and never written by the recorder, whose upsert
-- names only caller, host_kind, last_seen_at, method and origin: PostgREST's merge
-- updates only the columns it is sent, so an hourly refresh cannot move it. Existing
-- rows take their last sighting, which is the earliest moment the table can vouch for
-- (the migration's own time would claim a first sighting that never happened then).

alter table api_caller_seen
  add column first_seen_at timestamptz not null default now();

update api_caller_seen set first_seen_at = last_seen_at;
