-- #3582: link a coverage sweep to the Twilio tier/pool DEMOTION that caused it, and make
-- enqueuing one safe to run twice.
--
-- A full pool exit (offboarding #1241, Twilio Redistribute #2115) strands every call an
-- agent holds, and each already has its own cause column so the coverage panel can say why
-- the sweep exists. A DEMOTION is the partial case: an agent demoted off a tier (for
-- example ultra_high to high, or a backend_service change) can still legitimately serve the
-- bookings in the pools they KEPT, and only the bookings in the pool they lost must move.
-- That is still a system-initiated sweep with no human actor, and it needs the same "why"
-- record and the same run-twice safety as its siblings.
--
-- A FOURTH nullable cause column rather than a shared "source" column, for the same reason
-- 0107 and 0119 were their own: each names the exact record that explains the sweep.
--
-- The value is the moment the hourly roster sync recorded the demotion, stored on the
-- agent's own `attributes.demotion_marked_at` in the SAME write as the narrowed tiers, and
-- READ BACK rather than minted per run (0119's rule): a key derived from "now" would mint a
-- new one every hour and this index would never fire, so a crashed or re-run sync would
-- enqueue a second job and double-move a customer. Coming back up to the tier before the
-- debounce clears the stamp with the demotion, so a transient or flapped tag moves nobody;
-- a LATER, genuinely different demotion writes its own stamp and correctly gets its own
-- sweep rather than colliding with an old one.
alter table bulk_reassign_jobs
  add column demotion_marked_at timestamptz;

-- The idempotency key. Both columns are non-null inside the partial, so like 0107 and 0119
-- and unlike 0095 there is no NULL-never-equals-NULL hole needing a second index.
--
-- Partial (WHERE NOT NULL) so every other sweep is unaffected: many NULLs are permitted. A
-- partial unique index cannot back an ON CONFLICT clause, so the code inserts and handles
-- 23505, then re-snapshots into the existing job rather than merely refusing the duplicate
-- (a refusal would strand a half-written job, #1235).
create unique index bulk_reassign_jobs_demotion_idx
  on bulk_reassign_jobs (out_user_id, demotion_marked_at)
  where demotion_marked_at is not null;

comment on column bulk_reassign_jobs.demotion_marked_at is
  'The Twilio tier/pool demotion this sweep covers (#3582): the moment the hourly roster sync recorded the agent lost eligibility a held booking needs, stored on users.attributes.demotion_marked_at in the same write as the narrowed tiers. NULL for a sweep a person started, one an approved time-off request caused, one an offboarding caused, or a full redistribute pool exit. Unique per (agent, demotion), so a retried or crashed sync converges on one sweep. Also the record of WHY the job has no created_by: a demotion sweep has no human actor and its moves are recorded as system-initiated.';
