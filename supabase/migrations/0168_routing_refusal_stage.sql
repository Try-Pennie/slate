-- #3272: a refused confirm records WHEN it asked for, WHICH stage refused it, and
-- WHO it was.
--
-- On 2026-10-04 twenty three confirms were refused between 19:29 and 20:44 ET and
-- not one could be traced to the instant the lead picked: the log line carried only
-- the status, routing_decisions had no start column, and the reservation row is
-- deleted on a terminal refusal. So a spike could only be argued from timing.
--
-- Four columns, all null on a booked decision and on every row written before this:
--   * requested_start: the instant the lead asked for, so a refusal can be looked up
--     by time and bucket (the index below serves exactly that);
--   * refusal_stage: where the confirm was refused. The vocabulary is the list the
--     code holds (src/lib/booking/refusal-trace.ts, REFUSAL_STAGES), and
--     scripts/test-refusal-stage.ts holds the two together;
--   * stage_counts: per rung tried, how many advisors were in the pool, read free
--     from the cache, claimed by confirms beside it, and sent to Google. This is what
--     tells "nobody free in the cache" apart from "Google said everyone was busy".
--     Counts and bucket codes only;
--   * lead_id: the refused lead's Salesforce lead id (00Q), in its 15 character form,
--     so a run of refusals can be counted in people (#3276: one lead retried six
--     times in 90 seconds that night). An external id, safe to store (Dan,
--     2026-10-01); never a name, email or phone.
--
-- Additive for the deployed code: new nullable columns, a check and an index. The
-- deployed insert names its columns, so it is unaffected. The mirror does not carry
-- these (scripts/lib/snowflake-restore.ts, UNMIRRORED_COLUMNS).

alter table routing_decisions
  add column if not exists requested_start timestamptz,
  add column if not exists refusal_stage text,
  add column if not exists stage_counts jsonb,
  add column if not exists lead_id text;

alter table routing_decisions
  add constraint routing_decisions_refusal_stage_check
  check (
    refusal_stage is null
    or refusal_stage in (
      'pool_empty',
      'candidate_read_empty',
      'verify_busy',
      'verify_unreadable',
      'race_lost'
    )
  );

comment on column routing_decisions.requested_start is
  'The instant the lead asked for, on a refused confirm (#3272). NULL on a booked decision and on rows written before 0168.';
comment on column routing_decisions.refusal_stage is
  'Which stage refused the confirm (#3272): pool_empty, candidate_read_empty, verify_busy, verify_unreadable or race_lost. NULL when nothing was refused. A confirm answered from the verdict ahead of it in the slot''s line writes no row; it is on the confirm answered log line.';
comment on column routing_decisions.stage_counts is
  'Per rung tried, in ladder order: {code, members, read, claimed, checked, stage}. Counts only (#3272).';
comment on column routing_decisions.lead_id is
  'The refused lead''s Salesforce lead id, first 15 characters (#3272, #3276). NULL when the request named no lead.';

-- A refusal is looked up by bucket and instant. Partial, because only refused rows
-- carry a start and they are a small minority of a table that takes a row per booking.
create index if not exists routing_decisions_refusal_lookup_idx
  on routing_decisions (bucket_code, requested_start)
  where requested_start is not null;
