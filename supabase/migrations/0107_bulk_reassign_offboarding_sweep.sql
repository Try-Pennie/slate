-- #1241: link a coverage sweep to the offboarding deactivation that caused it,
-- and make enqueuing one safe to run twice.
--
-- POST /api/users/deactivate is the offboarding automation's entry point. It has
-- no human in it, so on the deactivate transition it now enqueues the coverage
-- sweep itself instead of leaving the departed agent's confirmed appointments
-- with them until the inactive_agent_bookings monitor asks somebody, about an
-- hour later, to run the coverage panel by hand.
--
-- An automation retries, and two of its calls can be in flight at once, so the
-- enqueue needs an idempotency key the DATABASE enforces rather than ordering in
-- application code. This is the same shape 0095 gave the time-off sweeps, for the
-- same reason, and it is deliberately a SECOND nullable cause column rather than
-- one shared "source" column: each one names the exact record that explains the
-- sweep, which is what the admin coverage panel needs in order to say why a sweep
-- exists.
--
-- The value is the agent's stored `deactivated_at`, which is both the window
-- start (everything still ahead of the moment they left) and half the key. The
-- deactivate write is now a compare-and-swap on `deactivated_at is null`, so only
-- ONE caller ever performs the transition and every later call reads that same
-- stamp back: the key is stable across a retry, where a key derived from "now"
-- would mint a new one per call and this index would never fire.
--
-- Rehiring and offboarding somebody a second time is a DIFFERENT deactivation
-- with a different stamp, so it correctly gets its own sweep rather than
-- resurrecting a years-old one.
alter table bulk_reassign_jobs
  add column offboarding_deactivated_at timestamptz;

-- The idempotency key. Both columns are non-null inside the partial, so unlike
-- 0095 there is no NULL-never-equals-NULL hole needing a second index.
--
-- Partial (WHERE NOT NULL) so every other sweep, admin-initiated or from time
-- off, is unaffected: many NULLs are permitted. Note a partial unique index
-- cannot back an ON CONFLICT clause, so the code inserts and handles 23505, then
-- re-snapshots into the existing job rather than merely refusing the duplicate (a
-- refusal would strand a half-written job forever, #1235).
create unique index bulk_reassign_jobs_offboarding_idx
  on bulk_reassign_jobs (out_user_id, offboarding_deactivated_at)
  where offboarding_deactivated_at is not null;

comment on column bulk_reassign_jobs.offboarding_deactivated_at is
  'The deactivation this sweep covers (#1241): the agent''s deactivated_at at the moment the offboarding API deactivated them. NULL for a sweep a person started or one an approved time-off request caused. Unique per (agent, deactivation), so a retried or concurrent offboarding call converges on one sweep. Also the record of WHY the job has no created_by: an offboarding sweep has no human actor and its moves are recorded as system-initiated.';
